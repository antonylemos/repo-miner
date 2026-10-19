import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture } from '@tests/acquisition-helpers.js';
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

async function setup(repositories = 3) {
  const fixture = await createFixture({ repositories });
  const configPath = join(temporaryDirectory(), 'acquisition.json');
  writeFileSync(configPath, JSON.stringify(fixture.config));
  const args = ['acquire', '--config', configPath, '--output', fixture.output];
  return { fixture, configPath, args };
}

describe('acquire command', () => {
  it('should exit 0 without GITHUB_TOKEN and without touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { fixture, args } = await setup();
    expect(await main(args, {})).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    const lines = readFileSync(join(fixture.output, 'acquisition.csv'), 'utf8')
      .trimEnd()
      .split('\n');
    expect(lines).toHaveLength(4);
    for (const file of [
      'manifest.json',
      'corpus/org__repo-1/normalization.json',
    ])
      expect(existsSync(join(fixture.output, file))).toBe(true);
  });

  it('should exit 1 listing the problems and create nothing in --output when annotations are invalid', async () => {
    const { fixture, args } = await setup();
    fixture.writeAnnotation(1, { commit: 'f'.repeat(40) });
    fixture.writeAnnotation(2, { approaches: '[]' });
    expect(await main(args, {})).toBe(1);
    const message = errors.join('\n');
    expect(message).toContain('001-org__repo-1.md');
    expect(message).toContain('002-org__repo-2.md');
    expect(existsSync(fixture.output)).toBe(false);
  });

  it('should exit 1 when the sample changed after the draw', async () => {
    const { fixture, args } = await setup();
    writeFileSync(join(fixture.sample, 'sample.csv'), 'id\n1\n');
    expect(await main(args, {})).toBe(1);
    expect(errors.join('\n')).toContain('changed after the sample was drawn');
    expect(existsSync(fixture.output)).toBe(false);
  });

  it('should exit 1 for an unknown preset', async () => {
    const { fixture, configPath, args } = await setup();
    writeFileSync(
      configPath,
      JSON.stringify({ ...fixture.config, exclude: { presets: ['nodejs'] } }),
    );
    expect(await main(args, {})).toBe(1);
    expect(errors.join('\n')).toContain('nodejs');
    expect(existsSync(fixture.output)).toBe(false);
  });

  it('should exit 2 when a selected repository has no snapshot', async () => {
    const { fixture, args } = await setup();
    // A clone whose object database is gone cannot be read.
    rmSync(join(fixture.sample, 'repos', 'org__repo-2', '.git'), {
      recursive: true,
    });
    expect(await main(args, {})).toBe(2);
    expect(errors.join('\n')).toContain('org/repo-2');
    expect(
      readFileSync(join(fixture.output, 'acquisition.csv'), 'utf8')
        .trimEnd()
        .split('\n'),
    ).toHaveLength(3);
  });

  it('should require --config and --output', async () => {
    expect(await main(['acquire'], {})).toBe(1);
  });
});
