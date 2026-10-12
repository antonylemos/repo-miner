import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '@tests/helpers.js';
import {
  createRemote,
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { writeCsv } from '@/common/csv.js';
import {
  type CommandRunner,
  cloneSample,
  runCommand,
} from '@/modules/sampling/clone.js';

afterEach(removeTemporaryDirectories);

/** Writes ranking.csv for `total` repositories and sample.csv with the first `size`. */
async function createSample(total: number, size: number) {
  const directory = join(temporaryDirectory(), 'sample');
  mkdirSync(directory);
  const columns = ['rank', 'id', 'full_name', 'url'];
  const rows = Array.from({ length: total }, (_, index) => [
    index + 1,
    index + 1,
    `org/repo-${index + 1}`,
    `https://github.com/org/repo-${index + 1}`,
  ]);
  await writeCsv(join(directory, 'ranking.csv'), columns, rows);
  await writeCsv(join(directory, 'sample.csv'), columns, rows.slice(0, size));
  const remotes = temporaryDirectory();
  return {
    directory,
    remotes,
    remoteUrl: (fullName: string) => `file://${join(remotes, fullName)}`,
  };
}

const table = (directory: string, file: string) => {
  const [header, ...rows] = parseCsv(
    readFileSync(join(directory, file), 'utf8'),
  );
  return rows.map((row) =>
    Object.fromEntries((header as string[]).map((name, i) => [name, row[i]])),
  );
};

describe('cloneSample', () => {
  it('should clone every sampled repository and pin the commit and branch', async () => {
    const { directory, remotes, remoteUrl } = await createSample(5, 3);
    const commits = [1, 2, 3].map((n) =>
      createRemote(remotes, `org/repo-${n}`),
    );
    const result = await cloneSample({ directory, remoteUrl });
    expect(result).toMatchObject({
      size: 3,
      cloned: 3,
      failed: 0,
      exhausted: false,
    });
    expect(table(directory, 'clones.csv')).toMatchObject(
      [1, 2, 3].map((n) => ({
        rank: String(n),
        id: String(n),
        full_name: `org/repo-${n}`,
        status: 'cloned',
        commit_sha: commits[n - 1],
        branch: 'main',
        replaces: '',
        error: '',
      })),
    );
    expect(existsSync(join(directory, 'repos/org__repo-2/README.md'))).toBe(
      true,
    );
    expect(readdirSync(join(directory, 'repos')).sort()).toEqual([
      'org__repo-1',
      'org__repo-2',
      'org__repo-3',
    ]);
    expect(table(directory, 'catalog.csv')).toEqual(
      [1, 2, 3].map((n) => ({
        id: String(n),
        url: `https://github.com/org/repo-${n}`,
        classification: '',
      })),
    );
  });

  it('should replace a failed clone with the next of the ranking and record it', async () => {
    const { directory, remotes, remoteUrl } = await createSample(5, 3);
    for (const n of [1, 3, 4, 5]) createRemote(remotes, `org/repo-${n}`);
    const result = await cloneSample({ directory, remoteUrl });
    expect(result).toMatchObject({ cloned: 3, failed: 1, exhausted: false });
    const attempts = table(directory, 'clones.csv');
    expect(attempts.map((a) => [a.rank, a.status, a.replaces])).toEqual([
      ['1', 'cloned', ''],
      ['2', 'failed', ''],
      ['3', 'cloned', ''],
      ['4', 'cloned', '2'],
    ]);
    expect(attempts[1]).toMatchObject({ commit_sha: '', branch: '' });
    expect(attempts[1]?.error).not.toBe('');
    expect(existsSync(join(directory, 'repos/org__repo-2'))).toBe(false);
    expect(table(directory, 'catalog.csv').map((r) => r.id)).toEqual([
      '1',
      '3',
      '4',
    ]);
  });

  it('should stop with fewer clones when the ranking runs out', async () => {
    const { directory, remotes, remoteUrl } = await createSample(4, 3);
    createRemote(remotes, 'org/repo-1');
    const result = await cloneSample({ directory, remoteUrl });
    expect(result).toMatchObject({
      size: 3,
      cloned: 1,
      failed: 3,
      exhausted: true,
    });
    expect(table(directory, 'clones.csv')).toHaveLength(4);
  });

  it('should keep what clones.csv records and discard orphan directories on a rerun', async () => {
    const { directory, remotes, remoteUrl } = await createSample(4, 3);
    for (const n of [1, 2, 3, 4]) createRemote(remotes, `org/repo-${n}`);
    const controller = new AbortController();
    let clones = 0;
    const run: CommandRunner = async (file, args, options) => {
      if (args[0] === 'clone') clones += 1;
      if (args[0] === 'clone' && clones === 2) {
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      return runCommand(file, args, options);
    };
    const first = await cloneSample({
      directory,
      remoteUrl,
      run,
      signal: controller.signal,
    });
    expect(first).toMatchObject({ cloned: 1, interrupted: true });
    expect(table(directory, 'clones.csv').map((a) => a.id)).toEqual(['1']);
    expect(readdirSync(join(directory, 'repos'))).toEqual(['org__repo-1']);

    // An orphan: a clone directory no clones.csv row vouches for, and a stale partial.
    mkdirSync(join(directory, 'repos/org__repo-2'));
    mkdirSync(join(directory, 'repos/.org__repo-3.partial'));
    const attempted: string[] = [];
    const second = await cloneSample({
      directory,
      remoteUrl,
      run: async (file, args, options) => {
        if (args[0] === 'clone') attempted.push(String(args.at(-2)));
        return runCommand(file, args, options);
      },
    });
    expect(second).toMatchObject({ cloned: 3, interrupted: false });
    expect(
      attempted.map((url) => url.split('/').slice(-2).join('/')).sort(),
    ).toEqual(['org/repo-2', 'org/repo-3']);
    expect(table(directory, 'clones.csv').map((a) => a.id)).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(
      readFileSync(join(directory, 'repos/org__repo-2/README.md'), 'utf8'),
    ).toBe('org/repo-2');
  });

  it('should not attempt anything when the sample is already complete', async () => {
    const { directory, remotes, remoteUrl } = await createSample(3, 2);
    for (const n of [1, 2, 3]) createRemote(remotes, `org/repo-${n}`);
    await cloneSample({ directory, remoteUrl });
    const before = readFileSync(join(directory, 'clones.csv'), 'utf8');
    let clones = 0;
    const result = await cloneSample({
      directory,
      remoteUrl,
      run: async (file, args, options) => {
        if (args[0] === 'clone') clones += 1;
        return runCommand(file, args, options);
      },
    });
    expect(clones).toBe(0);
    expect(result).toMatchObject({ cloned: 2, failed: 0, exhausted: false });
    expect(readFileSync(join(directory, 'clones.csv'), 'utf8')).toBe(before);
  });

  it('should preserve the classifications already written in catalog.csv', async () => {
    const { directory, remotes, remoteUrl } = await createSample(3, 3);
    for (const n of [1, 2, 3]) createRemote(remotes, `org/repo-${n}`);
    const controller = new AbortController();
    let clones = 0;
    const run: CommandRunner = async (file, args, options) => {
      if (args[0] === 'clone') clones += 1;
      if (args[0] === 'clone' && clones === 2) {
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      return runCommand(file, args, options);
    };
    await cloneSample({ directory, remoteUrl, run, signal: controller.signal });
    const catalog = join(directory, 'catalog.csv');
    const edited = readFileSync(catalog, 'utf8').replace(
      '/repo-1,',
      '/repo-1,MFE-implemented',
    );
    writeFileSync(catalog, edited);
    await cloneSample({ directory, remoteUrl });
    expect(readFileSync(catalog, 'utf8').startsWith(edited)).toBe(true);
    expect(table(directory, 'catalog.csv').map((r) => r.id)).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('should fail before cloning when sample.csv is missing', async () => {
    const { directory, remoteUrl } = await createSample(2, 1);
    rmSync(join(directory, 'sample.csv'));
    await expect(cloneSample({ directory, remoteUrl })).rejects.toThrow(
      /sample\.csv/,
    );
    expect(existsSync(join(directory, 'clones.csv'))).toBe(false);
  });

  it('should fail before any attempt when git is unavailable', async () => {
    const { directory, remoteUrl } = await createSample(2, 1);
    const run: CommandRunner = async () => {
      throw new Error('spawn git ENOENT');
    };
    await expect(cloneSample({ directory, remoteUrl, run })).rejects.toThrow(
      /git was not found/,
    );
    expect(existsSync(join(directory, 'clones.csv'))).toBe(false);
    expect(existsSync(join(directory, 'repos'))).toBe(false);
  });
});
