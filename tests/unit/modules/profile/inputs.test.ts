import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createProfileFixture,
  FIXTURE_COMMIT,
  profileConfig,
} from '@tests/profile-helpers.js';
import { removeTemporaryDirectories } from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandRunner } from '@/common/command.js';
import { parseProfileConfig } from '@/modules/profile/config.js';
import { readInputs } from '@/modules/profile/inputs.js';

afterEach(removeTemporaryDirectories);

const hasEverything: CommandRunner = async () => '';

async function setup(repositories: Parameters<typeof createProfileFixture>[0]) {
  const fixture = await createProfileFixture(repositories);
  return {
    ...fixture,
    config: parseProfileConfig(profileConfig(fixture.acquisition)),
  };
}

describe('readInputs', () => {
  it('should read the repositories with their commit, reference instant and clone', async () => {
    const { config, sample } = await setup([
      {
        fullName: 'org/a',
        referenceAt: '2026-10-12T01:02:03.000Z',
        columns: { repo_type: 'example' },
      },
      { fullName: 'org/b' },
    ]);
    const inputs = await readInputs(config, hasEverything);
    expect(inputs.sampleDirectory).toBe(sample);
    expect(inputs.repositories.map((r) => r.fullName)).toEqual([
      'org/a',
      'org/b',
    ]);
    const [first] = inputs.repositories;
    expect(first?.commitSha).toBe(FIXTURE_COMMIT);
    expect(first?.referenceAt).toBe('2026-10-12T01:02:03.000Z');
    expect(first?.clone).toBe(join(sample, 'repos', 'org__a'));
    expect(first?.row.repo_type).toBe('example');
  });

  it('should ask each clone for its commit', async () => {
    const { config } = await setup([{ fullName: 'org/a' }]);
    const asked: string[] = [];
    await readInputs(config, async (_file, args) => {
      asked.push(args.at(-1) as string);
      return '';
    });
    expect(asked).toEqual([`${FIXTURE_COMMIT}^{commit}`]);
  });

  it('should report a commit that differs from the acquisition', async () => {
    const { config, sample } = await setup([{ fullName: 'org/a' }]);
    const other = 'b'.repeat(40);
    const path = join(sample, 'clones.csv');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(FIXTURE_COMMIT, other),
    );
    await expect(readInputs(config, hasEverything)).rejects.toThrow(
      new RegExp(`org/a.*${other}.*${FIXTURE_COMMIT}`),
    );
  });

  it('should report a repository without a cloned row', async () => {
    const { config } = await setup([
      { fullName: 'org/a', notCloned: true },
      { fullName: 'org/b' },
    ]);
    await expect(readInputs(config, hasEverything)).rejects.toThrow(
      /org\/a.*no cloned row/,
    );
  });

  it('should report a missing clone directory and a clone without the commit', async () => {
    const { config } = await setup([
      { fullName: 'org/a', noClone: true },
      { fullName: 'org/b' },
    ]);
    const error = await readInputs(config, async (_file, _args, options) => {
      if (options.cwd?.endsWith('org__b')) throw new Error('bad object');
      return '';
    }).catch((failure: Error) => failure);
    expect((error as Error).message).toMatch(/2 problems/);
    expect((error as Error).message).toMatch(/org\/a.*does not exist/);
    expect((error as Error).message).toMatch(
      /org\/b.*does not have the commit/,
    );
  });

  it('should list every problem before failing', async () => {
    const { config } = await setup([
      { fullName: 'org/a', notCloned: true },
      { fullName: 'org/b', notCloned: true },
    ]);
    await expect(readInputs(config, hasEverything)).rejects.toThrow(
      /2 problems[\s\S]*org\/a[\s\S]*org\/b/,
    );
  });

  it('should reject an invalid attempted_at', async () => {
    const { config } = await setup([
      { fullName: 'org/a', referenceAt: 'yesterday' },
    ]);
    await expect(readInputs(config, hasEverything)).rejects.toThrow(
      /invalid attempted_at yesterday/,
    );
  });

  it('should reject an acquisition manifest without the sample', async () => {
    const { config, acquisition } = await setup([{ fullName: 'org/a' }]);
    writeFileSync(join(acquisition, 'manifest.json'), '{"schema":1}');
    await expect(readInputs(config, hasEverything)).rejects.toThrow(
      /does not record the sample/,
    );
  });
});
