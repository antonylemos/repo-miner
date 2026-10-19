import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMining, inspectionConfig } from '@tests/inspection-helpers.js';
import type { FixtureRepository } from '@tests/mining-helpers.js';
import { removeTemporaryDirectories } from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256File } from '@/common/hash.js';
import { parseInspectionConfig } from '@/modules/inspection/config.js';
import { readInputs } from '@/modules/inspection/inputs.js';

afterEach(removeTemporaryDirectories);

const repositories: FixtureRepository[] = [
  {
    fullName: 'org/a',
    files: {
      'package.json': '{}\n',
      'webpack.config.js': 'x\nremotes: {}\n',
    },
  },
  { fullName: 'org/b', files: { 'package.json': '{}\n' } },
];

describe('readInputs', () => {
  it('should read the matches, the unit directories and the hashes of an intact mining', async () => {
    const mining = await createMining(repositories);
    const inputs = await readInputs(
      parseInspectionConfig(inspectionConfig(mining.directory)),
    );
    expect(inputs.miningDirectory).toBe(mining.directory);
    expect(inputs.miningManifestSha256).toBe(
      await sha256File(join(mining.directory, 'manifest.json')),
    );
    expect(inputs.repositories.map((repo) => repo.fullName)).toEqual([
      'org/a',
      'org/b',
    ]);
    expect(inputs.repositories[0]?.matches).toEqual([
      { pattern: 'cfg-remotes', path: 'webpack.config.js', line: '2' },
    ]);
  });

  it('should list the repository and the hashes when a snapshot was changed after the mining', async () => {
    const mining = await createMining(repositories);
    writeFileSync(
      join(mining.acquisition.snapshot('org/a'), 'files', 'package.json'),
      '{"edited":true}\n',
    );
    await expect(
      readInputs(parseInspectionConfig(inspectionConfig(mining.directory))),
    ).rejects.toThrow(/org\/a.*content_sha256/);
  });

  it('should list the file when the mining lacks matches.csv', async () => {
    const mining = await createMining(repositories);
    rmSync(join(mining.directory, 'repos', 'org__a', 'matches.csv'));
    await expect(
      readInputs(parseInspectionConfig(inspectionConfig(mining.directory))),
    ).rejects.toThrow(join('repos', 'org__a', 'matches.csv'));
  });

  it('should not require units.csv', async () => {
    const mining = await createMining(repositories);
    rmSync(join(mining.directory, 'repos', 'org__a', 'units.csv'));
    const inputs = await readInputs(
      parseInspectionConfig(inspectionConfig(mining.directory)),
    );
    expect(inputs.repositories.map((repo) => repo.fullName)).toEqual([
      'org/a',
      'org/b',
    ]);
  });

  it('should list the technology and the pattern when the pattern is not in the catalog', async () => {
    const mining = await createMining(repositories);
    const config = inspectionConfig(mining.directory);
    config.technologies[0]?.patterns.push('cfg-remote');
    await expect(readInputs(parseInspectionConfig(config))).rejects.toThrow(
      'Technology tech-a uses the pattern cfg-remote, which is not in the mining catalog.',
    );
  });

  it('should list every problem at once', async () => {
    const mining = await createMining(repositories);
    writeFileSync(
      join(mining.acquisition.snapshot('org/b'), 'files', 'package.json'),
      '{"edited":true}\n',
    );
    rmSync(join(mining.directory, 'repos', 'org__a', 'matches.csv'));
    const config = inspectionConfig(mining.directory);
    config.technologies[1]?.patterns.push('nope');
    const error = await readInputs(parseInspectionConfig(config)).catch(
      (caught: Error) => caught,
    );
    expect(String(error)).toContain('3 problems');
    expect(String(error)).toContain('nope');
    expect(String(error)).toContain('org/b');
    expect(String(error)).toContain('matches.csv');
  });

  it('should fail when the mining has no manifest.json', async () => {
    const mining = await createMining(repositories);
    rmSync(join(mining.directory, 'manifest.json'));
    await expect(
      readInputs(parseInspectionConfig(inspectionConfig(mining.directory))),
    ).rejects.toThrow('manifest.json does not exist.');
  });

  it('should fail when manifest.json is not a mining manifest', async () => {
    const mining = await createMining(repositories);
    writeFileSync(join(mining.directory, 'manifest.json'), '{}');
    await expect(
      readInputs(parseInspectionConfig(inspectionConfig(mining.directory))),
    ).rejects.toThrow('is not a mining manifest.');
  });
});
