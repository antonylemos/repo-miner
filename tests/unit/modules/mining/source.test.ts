import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAcquisition,
  type FixtureRepository,
} from '@tests/mining-helpers.js';
import { describe, expect, it } from 'vitest';
import { sha256File } from '@/common/hash.js';
import { listFiles, readSource } from '@/modules/mining/source.js';

const repositories: FixtureRepository[] = [
  {
    fullName: 'org/a',
    files: {
      'package.json': '{}\n',
      'src/index.js': 'export {};\n',
      'bin/run': { content: '#!/bin/sh\n', executable: true },
    },
  },
  { fullName: 'org/b', files: { 'README.md': 'b\n' } },
];

describe('readSource', () => {
  it('should read an intact acquisition in the order of acquisition.csv', async () => {
    const acquisition = await createAcquisition(repositories);
    const source = await readSource(acquisition.directory);
    expect(source.repositories.map((item) => item.fullName)).toEqual([
      'org/a',
      'org/b',
    ]);
    expect(source.repositories[0]?.directoryName).toBe('org__a');
    expect(source.repositories[0]?.filesDirectory).toBe(
      join(acquisition.snapshot('org/a'), 'files'),
    );
  });

  it('should record the hashes of manifest.json and acquisition.csv', async () => {
    const acquisition = await createAcquisition(repositories);
    const source = await readSource(acquisition.directory);
    expect(source.manifestSha256).toBe(
      await sha256File(join(acquisition.directory, 'manifest.json')),
    );
    expect(source.acquisitionSha256).toBe(
      await sha256File(join(acquisition.directory, 'acquisition.csv')),
    );
  });

  it('should report a snapshot that does not exist', async () => {
    const acquisition = await createAcquisition(repositories);
    rmSync(acquisition.snapshot('org/b'), { recursive: true });
    await expect(readSource(acquisition.directory)).rejects.toThrow(
      /org\/b: the snapshot .* does not exist/,
    );
  });

  it('should report an edited file with both hashes', async () => {
    const acquisition = await createAcquisition(repositories);
    writeFileSync(
      join(acquisition.snapshot('org/a'), 'files', 'src/index.js'),
      'edited\n',
    );
    const error = await readSource(acquisition.directory).catch((e) => e);
    expect(error.message).toMatch(/org\/a: acquisition.csv has content_sha256/);
    expect(error.message).toMatch(/normalization.json has [0-9a-f]{64}/);
    expect(error.message).toMatch(/files hash to [0-9a-f]{64}/);
  });

  it('should report a changed execute bit', async () => {
    const acquisition = await createAcquisition(repositories);
    chmodSync(join(acquisition.snapshot('org/a'), 'files', 'bin/run'), 0o644);
    await expect(readSource(acquisition.directory)).rejects.toThrow(
      /org\/a: acquisition.csv has content_sha256/,
    );
  });

  it('should report every problem together', async () => {
    const acquisition = await createAcquisition(repositories);
    writeFileSync(
      join(acquisition.snapshot('org/a'), 'files', 'package.json'),
      '{"x":1}\n',
    );
    rmSync(acquisition.snapshot('org/b'), { recursive: true });
    const error = await readSource(acquisition.directory).catch((e) => e);
    expect(error.message).toMatch(/2 problems; nothing was written/);
    expect(error.message).toMatch(/org\/a/);
    expect(error.message).toMatch(/org\/b/);
  });

  it('should report a normalization.json that disagrees with acquisition.csv', async () => {
    const acquisition = await createAcquisition(repositories);
    const path = join(acquisition.snapshot('org/b'), 'normalization.json');
    writeFileSync(path, JSON.stringify({ contentSha256: 'f'.repeat(64) }));
    await expect(readSource(acquisition.directory)).rejects.toThrow(
      /org\/b: .*normalization.json has f{64}/,
    );
  });

  it('should report a missing manifest.json', async () => {
    const acquisition = await createAcquisition(repositories);
    rmSync(join(acquisition.directory, 'manifest.json'));
    await expect(readSource(acquisition.directory)).rejects.toThrow(
      /manifest.json does not exist/,
    );
  });

  it('should not change any file of the acquisition', async () => {
    const acquisition = await createAcquisition(repositories);
    const before = readFileSync(join(acquisition.directory, 'acquisition.csv'));
    await readSource(acquisition.directory);
    expect(
      readFileSync(join(acquisition.directory, 'acquisition.csv')),
    ).toEqual(before);
  });
});

describe('listFiles', () => {
  it('should list files with / separators ordered by code point', async () => {
    const acquisition = await createAcquisition([
      {
        fullName: 'org/a',
        files: { 'b.js': 'b', 'Z.js': 'Z', 'a/z.js': 'z', 'a.js': 'a' },
      },
    ]);
    const files = listFiles(join(acquisition.snapshot('org/a'), 'files'));
    expect(files.map((file) => file.path)).toEqual([
      'Z.js',
      'a.js',
      'a/z.js',
      'b.js',
    ]);
    expect(files[0]).toEqual({ path: 'Z.js', size: 1, executable: false });
  });
});
