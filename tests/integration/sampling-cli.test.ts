import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  createRemote,
  createRound,
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '@/cli/main.js';

const candidates = Array.from({ length: 12 }, (_, index) => ({
  id: index + 1,
}));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTemporaryDirectories();
});

async function setup(config: Record<string, unknown> = {}) {
  const run = await createRound(candidates);
  const directory = temporaryDirectory();
  const configPath = join(directory, 'sample.json');
  writeFileSync(
    configPath,
    JSON.stringify({ run, size: 4, seed: 'cli-seed', ...config }),
  );
  return { run, configPath, output: join(directory, 'out') };
}

const sampleArgs = (configPath: string, output: string) => [
  'sample',
  '--config',
  configPath,
  '--output',
  output,
];

describe('sample command', () => {
  it('should draw the sample and exit 0 without GITHUB_TOKEN', async () => {
    const { configPath, output } = await setup();
    expect(await main(sampleArgs(configPath, output), {})).toBe(0);
    for (const file of ['ranking.csv', 'sample.csv', 'manifest.json'])
      expect(existsSync(join(output, file))).toBe(true);
  });

  it('should not touch the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { configPath, output } = await setup();
    await main(sampleArgs(configPath, output), {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should exit 1 without creating files when the seed is missing', async () => {
    const { configPath, output } = await setup({ seed: undefined });
    expect(await main(sampleArgs(configPath, output), {})).toBe(1);
    expect(existsSync(output)).toBe(false);
  });

  it('should exit 1 without creating files when size exceeds the population', async () => {
    const { configPath, output } = await setup({ size: 13 });
    expect(await main(sampleArgs(configPath, output), {})).toBe(1);
    expect(existsSync(output)).toBe(false);
  });

  it('should exit 1 without creating files when candidates.csv was altered', async () => {
    const { run, configPath, output } = await setup();
    const path = join(run, 'candidates.csv');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
    expect(await main(sampleArgs(configPath, output), {})).toBe(1);
    expect(existsSync(output)).toBe(false);
  });

  it('should exit 1 and keep an output directory that already has a sample', async () => {
    const { configPath, output } = await setup();
    mkdirSync(output);
    writeFileSync(join(output, 'sample.csv'), 'keep');
    expect(await main(sampleArgs(configPath, output), {})).toBe(1);
    expect(readFileSync(join(output, 'sample.csv'), 'utf8')).toBe('keep');
    expect(existsSync(join(output, 'ranking.csv'))).toBe(false);
  });
});

describe('clone command', () => {
  async function sampled(size: number) {
    const run = await createRound(candidates);
    const directory = temporaryDirectory();
    const configPath = join(directory, 'sample.json');
    const output = join(directory, 'out');
    writeFileSync(configPath, JSON.stringify({ run, size, seed: 'cli-seed' }));
    expect(await main(sampleArgs(configPath, output), {})).toBe(0);
    const ranking = readFileSync(join(output, 'ranking.csv'), 'utf8')
      .trimEnd()
      .split('\n')
      .slice(1)
      .map((line) => Number(line.split(',')[1]));
    return { output, ranking };
  }

  /** Points https://github.com/ at a local directory for the git child processes. */
  function redirectGitHub(root: string) {
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.file://${root}/.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/');
  }

  it('should exit 1 when the directory has no sample.csv', async () => {
    expect(await main(['clone', '--sample', temporaryDirectory()], {})).toBe(1);
  });

  it('should exit 0 once X repositories are cloned', async () => {
    const { output, ranking } = await sampled(3);
    const remotes = temporaryDirectory();
    redirectGitHub(remotes);
    for (const id of ranking) createRemote(remotes, `org/repo-${id}`, '.git');
    expect(await main(['clone', '--sample', output], {})).toBe(0);
    expect(readdirSync(join(output, 'repos'))).toHaveLength(3);
  });

  it('should exit 2 when the ranking runs out before X clones', async () => {
    const { output, ranking } = await sampled(3);
    const remotes = temporaryDirectory();
    redirectGitHub(remotes);
    createRemote(remotes, `org/repo-${ranking[0]}`, '.git');
    expect(await main(['clone', '--sample', output], {})).toBe(2);
    expect(readdirSync(join(output, 'repos'))).toHaveLength(1);
  });
});
