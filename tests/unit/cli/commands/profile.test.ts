import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileConfig } from '@tests/profile-helpers.js';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '@/cli/main.js';

afterEach(() => {
  vi.restoreAllMocks();
  removeTemporaryDirectories();
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    out.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    err.push(args.join(' '));
  });
  return { out, err };
}

describe('profile command', () => {
  it('should show its options without a token', async () => {
    const { out } = capture();
    expect(await main(['profile', '--help'], {})).toBe(0);
    const help = out.join('\n');
    expect(help).toContain('--config <file>');
    expect(help).toContain('--output <directory>');
    expect(help).toContain('GITHUB_TOKEN');
  });

  it('should require the config and the output', async () => {
    const { err } = capture();
    expect(await main(['profile'], {})).toBe(1);
    expect(err.join('\n')).toMatch(/--config/);
    expect(await main(['profile', '--config', 'x.json'], {})).toBe(1);
  });

  it('should exit with 1 and explain an invalid config', async () => {
    const { err } = capture();
    const directory = temporaryDirectory();
    const { version: _version, ...config } = profileConfig('data/a');
    writeFileSync(join(directory, 'config.json'), JSON.stringify(config));
    const code = await main(
      [
        'profile',
        '--config',
        join(directory, 'config.json'),
        '--output',
        join(directory, 'out'),
      ],
      {},
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/version/);
  });

  it('should exit with 1 when the acquisition does not exist', async () => {
    const { err } = capture();
    const directory = temporaryDirectory();
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify(profileConfig(join(directory, 'missing'))),
    );
    const code = await main(
      [
        'profile',
        '--config',
        join(directory, 'config.json'),
        '--output',
        join(directory, 'out'),
      ],
      {},
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/does not exist/);
  });
});
