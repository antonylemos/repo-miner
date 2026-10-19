import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAcquisition } from '@tests/mining-helpers.js';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '@/cli/main.js';

let errors: string[] = [];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
    errors.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  removeTemporaryDirectories();
});

async function setup(overrides: Record<string, unknown> = {}) {
  const acquisition = await createAcquisition([
    {
      fullName: 'org/a',
      files: { 'package.json': '{}\n', 'src/a.js': "import('remote/App')\n" },
    },
  ]);
  const config = {
    acquisition: acquisition.directory,
    version: '1',
    artifactTypes: {
      'dependency-manifest': ['**/package.json'],
      source: ['**/*.js'],
    },
    patterns: [
      {
        id: 'src-import',
        artifactTypes: ['source'],
        regex: 'import\\([\'"][^.]',
        rationale: 'Remote import',
      },
    ],
    units: { artifactTypes: ['dependency-manifest'] },
    ...overrides,
  };
  const configPath = join(temporaryDirectory(), 'mining.json');
  writeFileSync(configPath, JSON.stringify(config));
  const output = join(temporaryDirectory(), 'mining');
  return {
    acquisition,
    output,
    args: ['mine', '--config', configPath, '--output', output],
  };
}

describe('mine command', () => {
  it('should exit 0 without GITHUB_TOKEN and without touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { output, args } = await setup();
    expect(await main(args, {})).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const file of [
      'manifest.json',
      'summary.csv',
      'repos/org__a/artifacts.csv',
      'repos/org__a/matches.csv',
      'repos/org__a/units.csv',
    ])
      expect(existsSync(join(output, file))).toBe(true);
    expect(readFileSync(join(output, 'repos/org__a/matches.csv'), 'utf8')).toBe(
      "pattern,path,line,excerpt\nsrc-import,src/a.js,1,import('remote/App')\n",
    );
  });

  it('should exit 1 and create nothing for an invalid config', async () => {
    const { output, args } = await setup({ filters: [] });
    expect(await main(args, {})).toBe(1);
    expect(errors.join('\n')).toContain('filters');
    expect(existsSync(output)).toBe(false);
  });

  it('should exit 1 and create nothing when a snapshot was changed', async () => {
    const { acquisition, output, args } = await setup();
    writeFileSync(
      join(acquisition.snapshot('org/a'), 'files', 'src/a.js'),
      'edited\n',
    );
    expect(await main(args, {})).toBe(1);
    expect(errors.join('\n')).toContain('org/a');
    expect(existsSync(output)).toBe(false);
    expect(existsSync(`${output}.partial`)).toBe(false);
  });

  it('should exit 1 for a config file that is not JSON', async () => {
    const { output } = await setup();
    const path = join(temporaryDirectory(), 'broken.json');
    writeFileSync(path, '{');
    expect(await main(['mine', '--config', path, '--output', output], {})).toBe(
      1,
    );
    expect(existsSync(output)).toBe(false);
  });

  it('should exit 1 without --config', async () => {
    expect(await main(['mine', '--output', 'x'], {})).toBe(1);
  });
});
