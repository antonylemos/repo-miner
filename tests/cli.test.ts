import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';
import type { Catalog } from '../src/discovery/types.js';
import {
  catalogOf,
  cleanupTestStores,
  createTestStore,
  query,
} from './helpers.js';

const repositoryQuery = query({ id: 'repo', q: 'microfrontend' });
const codeQuery = query({
  id: 'code',
  strategy: 'technology',
  endpoint: 'code',
  q: 'single-spa filename:package.json',
});
const env = { GITHUB_TOKEN: 'fake-token' };

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTestStores();
});

function workspace(catalog: Catalog = catalogOf([repositoryQuery])) {
  const { directory } = createTestStore(catalogOf([repositoryQuery]));
  const queriesPath = join(directory, 'queries.json');
  writeFileSync(queriesPath, JSON.stringify(catalog));
  return { directory, queriesPath, outputDir: join(directory, 'run') };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

const repository = (id: number, pushedAt = '2025-01-01T00:00:00Z') => ({
  id,
  node_id: `R_${id}`,
  full_name: `org/r${id}`,
  html_url: `https://github.com/org/r${id}`,
  pushed_at: pushedAt,
});

function githubMock(
  options: { codeFailsFirst?: boolean; totalCount?: number } = {},
) {
  const requested: string[] = [];
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/graphql') {
        requested.push('graphql');
        return json({
          data: {
            nodes: [{ databaseId: 92, pushedAt: '2025-06-01T00:00:00Z' }],
          },
        });
      }
      const endpoint = url.pathname.split('/').at(-1);
      requested.push(
        `${endpoint}:${url.searchParams.get('per_page')}:${url.searchParams.get('q')}`,
      );
      if (endpoint === 'repositories') {
        return json({
          total_count: options.totalCount ?? 1,
          incomplete_results: false,
          items: [repository(91)],
        });
      }
      if (
        options.codeFailsFirst &&
        requested.filter((r) => r.startsWith('code')).length === 1
      ) {
        return json({ message: 'Validation Failed' }, 422);
      }
      return json({
        total_count: options.totalCount ?? 1,
        incomplete_results: false,
        items: [
          {
            path: 'package.json',
            html_url: 'https://github.com/org/r92/blob/main/package.json',
            repository: {
              id: 92,
              node_id: 'R_92',
              full_name: 'org/r92',
              html_url: 'https://github.com/org/r92',
            },
          },
        ],
      });
    });
  return { fetch, requested };
}

describe('discovery CLI', () => {
  it('should show help without a token or network access', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await main(['discover', '--help'], {})).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--dry-run'));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Usage: repo-miner discover'),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should require a token before creating a discovery run', async () => {
    const { queriesPath, outputDir } = workspace();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await main(
      ['discover', '--queries', queriesPath, '--output', outputDir],
      {},
    );

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/GITHUB_TOKEN/));
    expect(existsSync(join(outputDir, 'discovery.sqlite'))).toBe(false);
  });

  it('should reject a version 1 catalog', async () => {
    const { queriesPath, outputDir } = workspace();
    writeFileSync(
      queriesPath,
      JSON.stringify({
        version: 1,
        queries: [{ id: 'x', strategy: 'broader', endpoint: 'code', q: 'x' }],
      }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await main(
      ['discover', '--queries', queriesPath, '--output', outputDir],
      env,
    );

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/version 2/));
  });

  it('should reject --dry-run combined with --output or --resume', async () => {
    const { queriesPath, outputDir } = workspace();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      await main(
        [
          'discover',
          '--queries',
          queriesPath,
          '--output',
          outputDir,
          '--dry-run',
        ],
        env,
      ),
    ).toBe(1);
    expect(
      await main(['discover', '--resume', outputDir, '--dry-run'], env),
    ).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/--dry-run/));
  });

  it('should print subquery totals in a dry run without creating files', async () => {
    const partitioned = catalogOf([
      query({
        id: 'p',
        q: 'microfrontend',
        partition: { by: 'created', from: '2030-01-01', interval: 'year' },
      }),
    ]);
    const { directory, queriesPath } = workspace(partitioned);
    const before = readdirSync(directory).sort();
    const { requested } = githubMock({ totalCount: 1500 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await main(
      ['discover', '--queries', queriesPath, '--dry-run'],
      env,
    );

    const output = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(code).toBe(2);
    expect(requested[0]).toMatch(
      /^repositories:1:microfrontend pushed:>=2024-01-01 created:<2030-01-01$/,
    );
    expect(output).toContain('| p | p#created:<2030-01-01 |');
    expect(output).toContain('Saturadas: 2');
    expect(readdirSync(directory).sort()).toEqual(before);
  }, 15_000);

  it('should return zero from a dry run when every subquery fits', async () => {
    const { queriesPath } = workspace();
    githubMock({ totalCount: 10 });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(
      await main(['discover', '--queries', queriesPath, '--dry-run'], env),
    ).toBe(0);
  });

  it('should return one when a dry-run request fails', async () => {
    const { directory, queriesPath } = workspace();
    const before = readdirSync(directory).sort();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ message: 'Bad credentials' }, 401),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      await main(['discover', '--queries', queriesPath, '--dry-run'], env),
    ).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/401/));
    expect(readdirSync(directory).sort()).toEqual(before);
  });

  it('should export a report without a token', async () => {
    const { directory } = createTestStore(catalogOf([repositoryQuery]));
    const fetch = vi.spyOn(globalThis, 'fetch');

    expect(await main(['report', '--run', directory], {})).toBe(0);
    expect(existsSync(join(directory, 'report.md'))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should return one when a report run database is missing', async () => {
    const { directory } = workspace();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      await main(['report', '--run', join(directory, 'missing')], {}),
    ).toBe(1);
  });

  it('should search, enrich code candidates and finish complete', async () => {
    const { queriesPath, outputDir } = workspace(
      catalogOf([repositoryQuery, codeQuery]),
    );
    const { requested } = githubMock();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await main(
      ['discover', '--queries', queriesPath, '--output', outputDir],
      env,
    );

    expect(code).toBe(0);
    expect(requested).toEqual([
      'repositories:100:microfrontend pushed:>=2024-01-01',
      'code:100:single-spa filename:package.json',
      'graphql',
    ]);
    const candidates = readFileSync(join(outputDir, 'candidates.csv'), 'utf8');
    expect(candidates).toMatch(
      /92,org\/r92,https:\/\/github\.com\/org\/r92,in_scope,2025-06-01T00:00:00Z,enrichment,[^,]+,ok/,
    );
  });

  it('should export and resume a partial run', async () => {
    const { queriesPath, outputDir } = workspace(
      catalogOf([repositoryQuery, codeQuery]),
    );
    const { requested } = githubMock({ codeFailsFirst: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(
      await main(
        ['discover', '--queries', queriesPath, '--output', outputDir],
        env,
      ),
    ).toBe(2);
    expect(readFileSync(join(outputDir, 'candidates.csv'), 'utf8')).toContain(
      'org/r91',
    );

    expect(await main(['discover', '--resume', outputDir], env)).toBe(0);
    expect(
      requested.filter((entry) => entry.startsWith('repositories')),
    ).toHaveLength(1);
    expect(requested.filter((entry) => entry.startsWith('code'))).toHaveLength(
      2,
    );
    expect(readFileSync(join(outputDir, 'candidates.csv'), 'utf8')).toContain(
      'org/r92',
    );
  });
});
