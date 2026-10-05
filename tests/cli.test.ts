import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';
import { catalogHash } from '../src/discovery/catalog.js';
import { openStore } from '../src/discovery/storage.js';
import type { Catalog } from '../src/discovery/types.js';

const dirs: string[] = [];
const stores: ReturnType<typeof openStore>[] = [];
const catalog: Catalog = {
  version: 1,
  queries: [
    {
      id: 'test',
      strategy: 'terminology',
      endpoint: 'repositories',
      q: 'microfrontend',
    },
  ],
};

function createDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'discovery-cli-'));
  dirs.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of dirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('discovery CLI', () => {
  it('should show help without a token or network access', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await main(['--help'], {});

    expect(code).toBe(0);
    expect(log).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should show report options in Commander subcommand help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await main(['report', '--help'], {});

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('--run <directory>'),
    );
  });

  it('should require a token before creating a discovery run', async () => {
    const directory = createDirectory();
    const queriesPath = join(directory, 'queries.json');
    const outputDir = join(directory, 'run');
    writeFileSync(
      queriesPath,
      JSON.stringify({
        version: 1,
        queries: [
          {
            id: 'test',
            strategy: 'terminology',
            endpoint: 'repositories',
            q: 'microfrontend',
          },
        ],
      }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await main(
      ['discover', '--queries', queriesPath, '--output', outputDir],
      {},
    );

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/GITHUB_TOKEN/));
    expect(existsSync(join(outputDir, 'discovery.sqlite'))).toBe(false);
  });

  it('should reject invalid flags before opening a run', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await main(
      ['report', '--run', '/missing', '--not-a-flag', 'value'],
      {},
    );

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/unknown option/i),
    );
  });

  it('should export a report without a token', async () => {
    const directory = createDirectory();
    const store = openStore(join(directory, 'discovery.sqlite'));
    stores.push(store);
    store.createRun(catalog, catalogHash(catalog), 'started');
    const fetch = vi.spyOn(globalThis, 'fetch');

    const code = await main(['report', '--run', directory], {});

    expect(code).toBe(0);
    expect(existsSync(join(directory, 'report.md'))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should return code two and export partial search coverage', async () => {
    const directory = createDirectory();
    const queriesPath = join(directory, 'queries.json');
    const outputDir = join(directory, 'run');
    writeFileSync(queriesPath, JSON.stringify(catalog));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          total_count: 1,
          incomplete_results: true,
          items: [
            {
              id: 81,
              full_name: 'org/partial',
              html_url: 'https://github.com/org/partial',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const code = await main(
      ['discover', '--queries', queriesPath, '--output', outputDir],
      { GITHUB_TOKEN: 'fake-token' },
    );

    expect(code).toBe(2);
    expect(existsSync(join(outputDir, 'discovery.sqlite'))).toBe(true);
    expect(existsSync(join(outputDir, 'report.md'))).toBe(true);
  });

  it('should return code zero after a complete discovery run', async () => {
    const directory = createDirectory();
    const queriesPath = join(directory, 'queries.json');
    const outputDir = join(directory, 'run');
    writeFileSync(queriesPath, JSON.stringify(catalog));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              id: 82,
              full_name: 'org/complete',
              html_url: 'https://github.com/org/complete',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const code = await main(
      ['discover', '--queries', queriesPath, '--output', outputDir],
      { GITHUB_TOKEN: 'fake-token' },
    );

    expect(code).toBe(0);
    expect(existsSync(join(outputDir, 'discovery.sqlite'))).toBe(true);
    expect(existsSync(join(outputDir, 'candidates.csv'))).toBe(true);
  });

  it('should return code one when a report run database is missing', async () => {
    const directory = createDirectory();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await main(['report', '--run', directory], {});

    expect(code).toBe(1);
    expect(error).toHaveBeenCalled();
    expect(existsSync(join(directory, 'discovery.sqlite'))).toBe(false);
  });

  it('should export and resume a real run with a mocked GitHub fetch', async () => {
    const directory = createDirectory();
    const queriesPath = join(directory, 'queries.json');
    const outputDir = join(directory, 'run');
    const twoQueries: Catalog = {
      version: 1,
      queries: [
        catalog.queries[0],
        {
          id: 'code-query',
          strategy: 'technology',
          endpoint: 'code',
          q: 'single-spa',
        },
      ],
    };
    writeFileSync(queriesPath, JSON.stringify(twoQueries));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const requested: string[] = [];
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        const endpoint = url.pathname.split('/').at(-1);
        requested.push(`${endpoint}:${url.searchParams.get('q')}`);
        if (endpoint === 'repositories') {
          return new Response(
            JSON.stringify({
              total_count: 1,
              incomplete_results: false,
              items: [
                {
                  id: 91,
                  full_name: 'org/first',
                  html_url: 'https://github.com/org/first',
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (
          requested.filter((entry) => entry.startsWith('code:')).length === 1
        ) {
          return new Response(
            JSON.stringify({ message: 'Validation Failed' }),
            {
              status: 422,
            },
          );
        }
        return new Response(
          JSON.stringify({
            total_count: 1,
            incomplete_results: false,
            items: [
              {
                path: 'src/main.ts',
                html_url: 'https://github.com/org/second/blob/main/src/main.ts',
                repository: {
                  id: 92,
                  full_name: 'org/second',
                  html_url: 'https://github.com/org/second',
                },
              },
            ],
          }),
          { status: 200 },
        );
      });
    const env = { GITHUB_TOKEN: 'fake-token' };

    const firstCode = await main(
      ['discover', '--queries', queriesPath, '--output', outputDir],
      env,
    );
    expect(firstCode).toBe(2);
    expect(readFileSync(join(outputDir, 'candidates.csv'), 'utf8')).toContain(
      'org/first',
    );

    const resumeCode = await main(['discover', '--resume', outputDir], env);

    expect(resumeCode).toBe(0);
    expect(requested).toHaveLength(3);
    expect(requested[2]).toContain('single-spa');
    expect(readFileSync(join(outputDir, 'candidates.csv'), 'utf8')).toContain(
      'org/second',
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
