import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMining, inspectionConfig } from '@tests/inspection-helpers.js';
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
  const mining = await createMining([
    {
      fullName: 'org/a',
      files: {
        'package.json': '{"dependencies":{"@scope/x":"^1.0.0"}}\n',
        'webpack.config.js': 'remotes: {}\n',
      },
    },
  ]);
  const configPath = join(temporaryDirectory(), 'inspection.json');
  const write = (config: Record<string, unknown>) =>
    writeFileSync(configPath, JSON.stringify(config));
  write({ ...inspectionConfig(mining.directory), ...overrides });
  const output = join(temporaryDirectory(), 'inspection');
  return {
    mining,
    output,
    write,
    args: ['inspect-dependencies', '--config', configPath, '--output', output],
  };
}

describe('inspect-dependencies command', () => {
  it('should exit 0 without GITHUB_TOKEN and without touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { output, args } = await setup();
    expect(await main(args, {})).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const file of [
      'manifest.json',
      'summary.csv',
      'repos/org__a/dependencies.csv',
      'repos/org__a/manifests.csv',
    ])
      expect(existsSync(join(output, file))).toBe(true);
    expect(
      readFileSync(join(output, 'repos/org__a/dependencies.csv'), 'utf8'),
    ).toBe(
      'manifest,line,section,package,version,technology,same_package_matches,other_package_matches\n' +
        'package.json,1,dependencies,@scope/x,^1.0.0,tech-a,webpack.config.js:1,\n',
    );
  });

  it('should exit 1 and create nothing for an invalid config', async () => {
    const { output, args } = await setup({ filters: [] });
    expect(await main(args, {})).toBe(1);
    expect(errors.join('\n')).toContain('filters');
    expect(existsSync(output)).toBe(false);
  });

  it('should exit 1 and create nothing when the config has no version', async () => {
    const { output, args } = await setup({ version: undefined });
    expect(await main(args, {})).toBe(1);
    expect(errors.join('\n')).toContain('version');
    expect(existsSync(output)).toBe(false);
  });

  it('should exit 1 and create nothing when a snapshot was changed after the mining', async () => {
    const { mining, output, args } = await setup();
    writeFileSync(
      join(mining.acquisition.snapshot('org/a'), 'files', 'package.json'),
      '{}\n',
    );
    expect(await main(args, {})).toBe(1);
    expect(errors.join('\n')).toContain('org/a');
    expect(existsSync(output)).toBe(false);
    expect(existsSync(`${output}.partial`)).toBe(false);
  });

  it('should keep the previous output when a later run fails', async () => {
    const { output, args, write, mining } = await setup();
    expect(await main(args, {})).toBe(0);
    const before = readFileSync(join(output, 'summary.csv'), 'utf8');
    write({ ...inspectionConfig(mining.directory), version: '2' });
    expect(await main(args, {})).toBe(1);
    expect(errors.join('\n')).toContain('another configuration or mining');
    expect(readFileSync(join(output, 'summary.csv'), 'utf8')).toBe(before);
    expect(existsSync(`${output}.partial`)).toBe(false);
  });

  it('should exit 1 for a config file that is not JSON', async () => {
    const { output } = await setup();
    const path = join(temporaryDirectory(), 'broken.json');
    writeFileSync(path, '{');
    expect(
      await main(
        ['inspect-dependencies', '--config', path, '--output', output],
        {},
      ),
    ).toBe(1);
    expect(existsSync(output)).toBe(false);
  });

  it('should exit 1 without --config', async () => {
    expect(await main(['inspect-dependencies', '--output', 'x'], {})).toBe(1);
  });
});
