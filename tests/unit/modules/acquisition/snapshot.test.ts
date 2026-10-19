import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExclusionRules } from '@/modules/acquisition/exclusion.js';
import {
  acquireSnapshot,
  FILES_DIRECTORY,
  type Normalization,
  parseTree,
} from '@/modules/acquisition/snapshot.js';

afterEach(removeTemporaryDirectories);

const identity = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const none: ExclusionRules = { presets: [], paths: [], maxFileBytes: null };
const all: ExclusionRules = {
  presets: ['node', 'python', 'build-output', 'binaries'],
  paths: ['**/*.min.js'],
  maxFileBytes: null,
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...identity },
    encoding: 'utf8',
  }).trim();
}

function createRepository(): string {
  const path = join(temporaryDirectory(), 'repo');
  mkdirSync(path, { recursive: true });
  git(path, 'init', '--quiet', '-b', 'main');
  git(path, 'config', 'uploadpack.allowFilter', 'true');
  git(path, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  return path;
}

function commitFiles(
  path: string,
  files: Record<string, string | Buffer>,
  message = 'commit',
): string {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), content);
  }
  git(path, 'add', '-A');
  git(path, 'commit', '--quiet', '-m', message);
  return git(path, 'rev-parse', 'HEAD');
}

function listFiles(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? listFiles(root, relative) : [relative];
    })
    .sort();
}

async function acquire(
  repository: string,
  commit: string,
  rules: ExclusionRules = none,
  now = new Date('2026-10-15T00:00:00Z'),
): Promise<{ normalization: Normalization; destination: string }> {
  const destination = join(temporaryDirectory(), 'snap');
  const normalization = await acquireSnapshot({
    id: '1',
    fullName: 'org/repo',
    repository,
    commit,
    destination,
    rules,
    now: () => now,
  });
  return { normalization, destination };
}

describe('parseTree', () => {
  it('should parse NUL-separated ls-tree records with tabs and spaces in paths', () => {
    const output = [
      '100644 blob aaaa       12\tsrc/a b.ts',
      '160000 commit bbbb       -\thost-app',
    ].join('\0');
    expect(parseTree(`${output}\0`)).toEqual([
      {
        mode: '100644',
        type: 'blob',
        oid: 'aaaa',
        size: 12,
        path: 'src/a b.ts',
      },
      {
        mode: '160000',
        type: 'commit',
        oid: 'bbbb',
        size: 0,
        path: 'host-app',
      },
    ]);
  });
});

describe('acquireSnapshot', () => {
  it('should write the files of the commit under files/ with a normalization record', async () => {
    const repository = createRepository();
    const commit = commitFiles(repository, {
      'README.md': 'hello',
      'src/index.ts': 'export {};\n',
    });
    const { normalization, destination } = await acquire(repository, commit);
    expect(listFiles(join(destination, FILES_DIRECTORY))).toEqual([
      'README.md',
      'src/index.ts',
    ]);
    expect(
      readFileSync(join(destination, FILES_DIRECTORY, 'src/index.ts'), 'utf8'),
    ).toBe('export {};\n');
    expect(
      JSON.parse(readFileSync(join(destination, 'normalization.json'), 'utf8')),
    ).toEqual(normalization);
    expect(normalization).toMatchObject({
      schema: 1,
      id: '1',
      commit,
      acquiredAt: '2026-10-15T00:00:00.000Z',
      kept: { files: 2, bytes: 16 },
      removed: [],
    });
    expect(existsSync(`${destination}.partial`)).toBe(false);
  });

  it('should read the classified commit, not the one in checkout', async () => {
    const repository = createRepository();
    const first = commitFiles(repository, { 'a.txt': 'one' });
    commitFiles(repository, { 'a.txt': 'two', 'b.txt': 'new' });
    const { destination } = await acquire(repository, first);
    expect(listFiles(join(destination, FILES_DIRECTORY))).toEqual(['a.txt']);
    expect(
      readFileSync(join(destination, FILES_DIRECTORY, 'a.txt'), 'utf8'),
    ).toBe('one');
    expect(git(repository, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('should remove excluded paths with their reason and keep lockfiles', async () => {
    const repository = createRepository();
    const commit = commitFiles(repository, {
      'package.json': '{}',
      'package-lock.json': '{}',
      'node_modules/react/index.js': 'x',
      'build/out.js': 'y',
      'vendor/app.min.js': 'z',
    });
    const { normalization, destination } = await acquire(
      repository,
      commit,
      all,
    );
    expect(listFiles(join(destination, FILES_DIRECTORY))).toEqual([
      'package-lock.json',
      'package.json',
    ]);
    expect(normalization.removed).toEqual([
      { path: 'build/out.js', reason: 'preset:build-output', size: 1 },
      { path: 'node_modules/react/index.js', reason: 'preset:node', size: 1 },
      { path: 'vendor/app.min.js', reason: 'path:**/*.min.js', size: 1 },
    ]);
    expect(normalization.rules).toEqual(all);
  });

  it('should drop a file with a NUL byte as binary and keep its record', async () => {
    const repository = createRepository();
    const commit = commitFiles(repository, {
      'data.dat': Buffer.from([1, 0, 2]),
      'text.txt': 'abc',
    });
    const { normalization, destination } = await acquire(
      repository,
      commit,
      all,
    );
    expect(listFiles(join(destination, FILES_DIRECTORY))).toEqual(['text.txt']);
    expect(normalization.removed).toEqual([
      { path: 'data.dat', reason: 'preset:binaries', size: 3 },
    ]);
  });

  it('should record a submodule that has no .gitmodules without following it', async () => {
    const repository = createRepository();
    commitFiles(repository, { 'a.txt': 'a' });
    git(
      repository,
      'update-index',
      '--add',
      '--cacheinfo',
      '160000,3148122fd6a8d6bd5d3d6d4b8bd0c58d0aa5f1ad,host-app',
    );
    git(repository, 'commit', '--quiet', '-m', 'gitlink');
    const commit = git(repository, 'rev-parse', 'HEAD');
    const { normalization, destination } = await acquire(repository, commit);
    expect(listFiles(join(destination, FILES_DIRECTORY))).toEqual(['a.txt']);
    expect(normalization.submodules).toEqual([
      { path: 'host-app', commit: '3148122fd6a8d6bd5d3d6d4b8bd0c58d0aa5f1ad' },
    ]);
  });

  it('should record a symbolic link with its target without materializing it', async () => {
    const repository = createRepository();
    writeFileSync(join(repository, 'real.txt'), 'real');
    symlinkSync('real.txt', join(repository, 'link.txt'));
    git(repository, 'add', '-A');
    git(repository, 'commit', '--quiet', '-m', 'link');
    const commit = git(repository, 'rev-parse', 'HEAD');
    const { normalization, destination } = await acquire(repository, commit);
    expect(listFiles(join(destination, FILES_DIRECTORY))).toEqual(['real.txt']);
    expect(normalization.symlinks).toEqual([
      { path: 'link.txt', target: 'real.txt' },
    ]);
  });

  it('should preserve the executable bit', async () => {
    const repository = createRepository();
    writeFileSync(join(repository, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    git(repository, 'add', '-A');
    git(repository, 'commit', '--quiet', '-m', 'exec');
    const commit = git(repository, 'rev-parse', 'HEAD');
    const { destination } = await acquire(repository, commit);
    const mode = statSync(join(destination, FILES_DIRECTORY, 'run.sh')).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it('should compute the same content hash in two acquisitions', async () => {
    const repository = createRepository();
    const commit = commitFiles(repository, {
      'b.txt': 'b',
      'a/c.txt': 'c',
      'a.txt': 'a',
    });
    const first = await acquire(repository, commit);
    const second = await acquire(
      repository,
      commit,
      none,
      new Date('2030-01-01T00:00:00Z'),
    );
    expect(first.normalization.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.normalization.contentSha256).toBe(
      first.normalization.contentSha256,
    );
  });

  it('should change the content hash when the content changes', async () => {
    const repository = createRepository();
    const first = commitFiles(repository, { 'a.txt': 'one' });
    const second = commitFiles(repository, { 'a.txt': 'two' });
    const a = await acquire(repository, first);
    const b = await acquire(repository, second);
    expect(a.normalization.contentSha256).not.toBe(
      b.normalization.contentSha256,
    );
  });

  it('should acquire a commit with no files to keep', async () => {
    const repository = createRepository();
    const commit = commitFiles(repository, { 'node_modules/x.js': 'x' });
    const { normalization, destination } = await acquire(
      repository,
      commit,
      all,
    );
    expect(normalization.kept).toEqual({ files: 0, bytes: 0 });
    expect(existsSync(join(destination, 'normalization.json'))).toBe(true);
  });

  it('should fail without fetching when a blob is missing from a partial clone', async () => {
    const remote = createRepository();
    const commit = commitFiles(remote, { 'a.txt': 'a', 'b.txt': 'b' });
    const clone = join(temporaryDirectory(), 'clone');
    execFileSync(
      'git',
      [
        'clone',
        '--quiet',
        '--no-checkout',
        '--filter=blob:none',
        `file://${remote}`,
        clone,
      ],
      { env: { ...process.env, ...identity } },
    );
    const destination = join(temporaryDirectory(), 'snap');
    await expect(
      acquireSnapshot({
        id: '1',
        fullName: 'org/repo',
        repository: clone,
        commit,
        destination,
        rules: none,
      }),
    ).rejects.toThrow();
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(`${destination}.partial`)).toBe(false);
  });

  it('should discard a leftover partial directory before writing', async () => {
    const repository = createRepository();
    const commit = commitFiles(repository, { 'a.txt': 'a' });
    const destination = join(temporaryDirectory(), 'snap');
    mkdirSync(`${destination}.partial/files`, { recursive: true });
    writeFileSync(join(`${destination}.partial/files`, 'stale.txt'), 'old');
    await acquireSnapshot({
      id: '1',
      fullName: 'org/repo',
      repository,
      commit,
      destination,
      rules: none,
    });
    expect(listFiles(join(destination, FILES_DIRECTORY))).toEqual(['a.txt']);
  });
});
