import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture } from '@tests/acquisition-helpers.js';
import { parseCsv } from '@tests/helpers.js';
import { removeTemporaryDirectories } from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { type CommandRunner, runCommand } from '@/common/command.js';
import { acquire } from '@/modules/acquisition/acquire.js';
import { parseAcquisitionConfig } from '@/modules/acquisition/config.js';

afterEach(removeTemporaryDirectories);

const table = (path: string) => {
  const [header, ...rows] = parseCsv(readFileSync(path, 'utf8'));
  return rows.map((row) =>
    Object.fromEntries((header as string[]).map((name, i) => [name, row[i]])),
  );
};

const manifest = (output: string) =>
  JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));

describe('acquire', () => {
  it('should acquire the selected repositories and write acquisition.csv in rank order', async () => {
    const fixture = await createFixture({
      repositories: 4,
      classification: (n) => (n === 3 ? 'B' : 'A'),
    });
    const result = await acquire({
      config: parseAcquisitionConfig(fixture.config),
      outputDir: fixture.output,
      now: () => new Date('2026-10-15T12:00:00Z'),
    });
    expect(result).toMatchObject({
      selected: 3,
      acquired: 3,
      written: 3,
      failures: [],
      unselected: 1,
      interrupted: false,
    });
    const rows = table(join(fixture.output, 'acquisition.csv'));
    expect(rows.map((row) => row.id)).toEqual(['1', '2', '4']);
    expect(rows[1]).toMatchObject({
      full_name: 'org/repo-2',
      url: 'https://github.com/org/repo-2',
      commit_sha: fixture.commits.get(2),
      default_branch: 'main',
      acquired_at: '2026-10-15T12:00:00.000Z',
      strategies: 'terminology;technology',
      discovery_language: 'TypeScript',
      discovery_size_kb: '102',
      files: '3',
      repo_type: 'example',
      approaches: 'module-federation;qiankun',
      'annotation.method': 'manual',
    });
    expect(rows[0]?.discovered_at).toBe('2026-10-08T15:01:00.000Z');
    expect(rows[0]?.discovery_language).toBe('');
    expect(
      existsSync(
        join(fixture.output, 'corpus', 'org__repo-1', 'normalization.json'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(fixture.output, 'corpus', 'org__repo-1', 'files', 'node_modules'),
      ),
    ).toBe(false);
  });

  it('should record the config, the sample hashes and each annotation hash in manifest.json', async () => {
    const fixture = await createFixture({ repositories: 2 });
    await acquire({
      config: parseAcquisitionConfig(fixture.config),
      outputDir: fixture.output,
    });
    const recorded = manifest(fixture.output);
    expect(recorded.configSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(recorded.sample).sort()).toEqual([
      'ranking.csv',
      'sample.csv',
    ]);
    expect(Object.keys(recorded.annotations)).toEqual(['1', '2']);
    expect(recorded.notSelected).toEqual([]);
  });

  it('should acquire only the new final annotations on a rerun', async () => {
    const fixture = await createFixture({
      repositories: 6,
      status: (n) => (n > 3 ? 'review' : 'final'),
    });
    const config = parseAcquisitionConfig(fixture.config);
    const first = await acquire({ config, outputDir: fixture.output });
    expect(first.written).toBe(3);
    expect(table(join(fixture.output, 'acquisition.csv'))).toHaveLength(3);
    for (const n of [4, 5, 6])
      fixture.writeAnnotation(n, {
        annotation: '\n  method: manual\n  status: final',
      });
    const second = await acquire({ config, outputDir: fixture.output });
    expect(second).toMatchObject({ selected: 6, acquired: 6, written: 3 });
    expect(table(join(fixture.output, 'acquisition.csv'))).toHaveLength(6);
  });

  it('should refuse a changed configuration without changing the output', async () => {
    const fixture = await createFixture({ repositories: 2 });
    await acquire({
      config: parseAcquisitionConfig(fixture.config),
      outputDir: fixture.output,
    });
    const before = readFileSync(join(fixture.output, 'manifest.json'), 'utf8');
    const changed = parseAcquisitionConfig({
      ...fixture.config,
      exclude: { presets: ['node'], paths: ['**/*.md'] },
    });
    await expect(
      acquire({ config: changed, outputDir: fixture.output }),
    ).rejects.toThrow(/use another output directory/);
    expect(readFileSync(join(fixture.output, 'manifest.json'), 'utf8')).toBe(
      before,
    );
  });

  it('should keep the snapshot of a reopened annotation but leave it out of acquisition.csv', async () => {
    const fixture = await createFixture({ repositories: 3 });
    const config = parseAcquisitionConfig(fixture.config);
    await acquire({ config, outputDir: fixture.output });
    fixture.writeAnnotation(2, {
      annotation: '\n  method: manual\n  status: review',
    });
    const result = await acquire({ config, outputDir: fixture.output });
    expect(result.noLongerSelected).toEqual([
      { id: '2', fullName: 'org/repo-2' },
    ]);
    expect(result).toMatchObject({ selected: 2, unselected: 1 });
    expect(
      table(join(fixture.output, 'acquisition.csv')).map((row) => row.id),
    ).toEqual(['1', '3']);
    expect(existsSync(join(fixture.output, 'corpus', 'org__repo-2'))).toBe(
      true,
    );
    expect(manifest(fixture.output).notSelected).toEqual([
      { id: '2', fullName: 'org/repo-2' },
    ]);
  });

  it('should list every input problem and write nothing', async () => {
    const fixture = await createFixture({ repositories: 4 });
    fixture.writeAnnotation(1, { commit: 'f'.repeat(40) });
    fixture.writeAnnotation(2, { approaches: '[]' });
    fixture.writeAnnotation(3, { classification: 'B' });
    const error = await acquire({
      config: parseAcquisitionConfig(fixture.config),
      outputDir: fixture.output,
    }).catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('3 problems');
    expect(message).toContain('001-org__repo-1.md');
    expect(message).toContain('002-org__repo-2.md');
    expect(message).toContain('003-org__repo-3.md');
    expect(existsSync(fixture.output)).toBe(false);
  });

  it('should refuse a sample whose files changed after the draw', async () => {
    const fixture = await createFixture({ repositories: 2 });
    writeFileSync(join(fixture.sample, 'sample.csv'), 'id\n1\n');
    await expect(
      acquire({
        config: parseAcquisitionConfig(fixture.config),
        outputDir: fixture.output,
      }),
    ).rejects.toThrow(/sample\.csv changed after the sample was drawn/);
    expect(existsSync(fixture.output)).toBe(false);
  });

  it('should reject an export field that collides with a fixed column', async () => {
    const fixture = await createFixture({ repositories: 1 });
    const config = parseAcquisitionConfig({
      ...fixture.config,
      annotations: { ...fixture.config.annotations, export: ['id'] },
    });
    await expect(
      acquire({ config, outputDir: fixture.output }),
    ).rejects.toThrow(/id collides/);
  });

  it('should refuse a git older than 2.44', async () => {
    const fixture = await createFixture({ repositories: 1 });
    const run: CommandRunner = async () => 'git version 2.43.0\n';
    await expect(
      acquire({
        config: parseAcquisitionConfig(fixture.config),
        outputDir: fixture.output,
        run,
      }),
    ).rejects.toThrow(/requires git 2\.44/);
    expect(existsSync(fixture.output)).toBe(false);
  });

  it('should report a failed snapshot and still write the others', async () => {
    const fixture = await createFixture({ repositories: 3 });
    const run: CommandRunner = async (file, args, options) => {
      if (args[0] === 'ls-tree' && options.cwd?.endsWith('org__repo-2'))
        throw new Error('fatal: bad object');
      return runCommand(file, args, options);
    };
    const result = await acquire({
      config: parseAcquisitionConfig(fixture.config),
      outputDir: fixture.output,
      run,
    });
    expect(result.acquired).toBe(2);
    expect(result.failures).toEqual([
      { id: '2', fullName: 'org/repo-2', error: 'fatal: bad object' },
    ]);
    expect(
      table(join(fixture.output, 'acquisition.csv')).map((row) => row.id),
    ).toEqual(['1', '3']);
    expect(existsSync(join(fixture.output, 'corpus', 'org__repo-2'))).toBe(
      false,
    );
  });

  it('should retry a failed snapshot on the next run', async () => {
    const fixture = await createFixture({ repositories: 2 });
    const config = parseAcquisitionConfig(fixture.config);
    const broken: CommandRunner = async (file, args, options) => {
      if (args[0] === 'ls-tree' && options.cwd?.endsWith('org__repo-2'))
        throw new Error('fatal: bad object');
      return runCommand(file, args, options);
    };
    await acquire({ config, outputDir: fixture.output, run: broken });
    const result = await acquire({ config, outputDir: fixture.output });
    expect(result).toMatchObject({ acquired: 2, written: 1, failures: [] });
  });

  it('should stop on an aborted signal and keep what is complete', async () => {
    const fixture = await createFixture({ repositories: 3 });
    const controller = new AbortController();
    const result = await acquire({
      config: parseAcquisitionConfig(fixture.config),
      outputDir: fixture.output,
      signal: controller.signal,
      onProgress: (done) => {
        if (done === 1) controller.abort();
      },
    });
    expect(result.interrupted).toBe(true);
    expect(result.acquired).toBeLessThan(3);
    expect(table(join(fixture.output, 'acquisition.csv')).length).toBe(
      result.acquired,
    );
  });

  it('should discard partial directories left by an earlier run', async () => {
    const fixture = await createFixture({ repositories: 1 });
    const config = parseAcquisitionConfig(fixture.config);
    await acquire({ config, outputDir: fixture.output });
    const partial = join(fixture.output, 'corpus', 'org__repo-9.partial');
    mkdirSync(partial);
    await acquire({ config, outputDir: fixture.output });
    expect(existsSync(partial)).toBe(false);
  });
});
