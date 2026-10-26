import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProfileFixture, profileConfig } from '@tests/profile-helpers.js';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '@/common/command.js';
import { readCsvRecords, writeCsv } from '@/common/csv.js';
import { profile } from '@/modules/profile/profile.js';

const failure = vi.hoisted(() => ({ on: false }));

vi.mock('@/common/csv.js', async (original) => {
  const actual = await original<typeof import('@/common/csv.js')>();
  return {
    ...actual,
    writeCsv: (path: string, ...rest: [string[], Iterable<unknown[]>]) => {
      if (failure.on && path.endsWith('languages.csv'))
        throw new Error('disk full');
      return actual.writeCsv(path, ...rest);
    },
  };
});

afterEach(() => {
  failure.on = false;
  removeTemporaryDirectories();
});

const COMMIT = 'a'.repeat(40);
const NOW = Date.parse('2026-10-24T12:00:00.000Z');

const run: CommandRunner = async (_file, args) => {
  if (args.includes('rev-list')) return '3\n';
  if (args.includes('log')) return '2026-10-01T23:00:00+00:00\n';
  return '';
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * A GitHub API double. `gone` lists the repositories that answer 404 for
 * everything; `missing` lists endpoint paths that answer 404 alone.
 */
function api(gone: string[] = [], missing: string[] = []) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    const name = url.pathname.split('/').slice(2, 4).join('/');
    if (gone.includes(name) || missing.includes(path))
      return json({ message: 'Not Found' }, 404);
    if (path === '') return json({ created_at: '2026-01-01T00:00:00Z' });
    if (path === '/stargazers/count') return json({ count: 3 });
    if (path === '/forks')
      return json([
        { created_at: '2026-09-01T00:00:00Z' },
        { created_at: '2026-10-20T00:00:00Z' },
      ]);
    return json([
      {
        author: { login: 'ana', type: 'User' },
        commit: { author: { name: 'Ana', email: 'a@x.com' } },
      },
      { author: null, commit: { author: { name: 'Bo', email: 'Bo@X.com' } } },
      {
        author: { login: 'bot[bot]', type: 'Bot' },
        commit: { author: { name: 'bot', email: 'b@x.com' } },
      },
    ]);
  });
}

const http = (fetchFn: typeof fetch) => ({
  fetchFn,
  now: () => NOW,
  sleep: async () => {},
});

function reviewFile(
  directory: string,
  name: string,
  fullName: string,
  body: string,
  status = 'final',
) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, name),
    `---\nschema: 1\nfull_name: ${fullName}\ncommit: ${COMMIT}\nannotation:\n  status: ${status}\n---\n\n${body}\n`,
  );
}

async function setup(
  names = ['org/a', 'org/b'],
  options: { status?: string; overrides?: Record<string, unknown> } = {},
) {
  const fixture = await createProfileFixture(
    names.map((fullName, index) => ({
      fullName,
      files: {
        'src/index.ts': 'x'.repeat(30),
        'src/style.css': 'x'.repeat(10),
        'package-lock.json': 'x'.repeat(500),
      },
      columns: {
        repo_type: 'example',
        approaches: index === 0 ? 'module-federation;qiankun' : 'single-spa',
      },
    })),
  );
  const reviews = temporaryDirectory();
  for (const [index, fullName] of names.entries()) {
    const n = String(index + 1).padStart(3, '0');
    reviewFile(
      join(reviews, 'structure'),
      `${n}.md`,
      fullName,
      `Apps: ${5 + index}`,
      options.status,
    );
    reviewFile(
      join(reviews, 'composition'),
      `${n}.md`,
      fullName,
      [
        '## Relations',
        '',
        '| # | Type |',
        '|---|---|',
        '| 1 | host → remote |',
        '| 2 | communication |',
        '',
        'Unrelated: a, b.',
      ].join('\n'),
    );
  }
  const config = profileConfig(fixture.acquisition, {
    reviews: profileConfig('x').reviews.map((review) => ({
      ...review,
      files: join(reviews, review.files.replace('reviews/', '')),
    })),
    ...options.overrides,
  });
  return {
    ...fixture,
    reviews,
    config,
    output: join(temporaryDirectory(), 'out'),
  };
}

const read = (output: string, file: string) =>
  readFileSync(join(output, file), 'utf8');

describe('profile', () => {
  it('should write profile.csv with the fixed columns and then the variables in config order', async () => {
    const { config, output } = await setup();
    const result = await profile({
      config,
      outputDir: output,
      token: 't',
      http: http(api()),
      run,
    });
    expect(result).toMatchObject({
      repositories: 2,
      validationDifferences: 0,
      changedReviews: [],
    });

    const header = read(output, 'profile.csv').split('\n')[0];
    expect(header).toBe(
      'id,full_name,commit_sha,reference_at,files,excluded_files,dominant_language,frontend_share,commits,last_commit_at,days_since_last_commit,created_at,age_days,stars,stars_observed_at,forks,contributors,api_status,domain,approach,approach_values,snapshot_apps,unrelated_units,relation_types,units',
    );
    const rows = await readCsvRecords(join(output, 'profile.csv'));
    expect(rows[0]).toMatchObject({
      full_name: 'org/a',
      commit_sha: COMMIT,
      reference_at: '2026-10-12T00:00:00.000Z',
      files: '3',
      excluded_files: '1',
      dominant_language: 'TypeScript',
      frontend_share: '1.000000',
      commits: '3',
      last_commit_at: '2026-10-01T23:00:00+00:00',
      days_since_last_commit: '10',
      created_at: '2026-01-01T00:00:00Z',
      age_days: '284',
      stars: '3',
      stars_observed_at: '2026-10-24T12:00:00.000Z',
      forks: '1',
      contributors: '2',
      api_status: '200',
      domain: 'example',
      approach: 'hybrid',
      approach_values: 'module-federation;qiankun',
      snapshot_apps: '5',
      unrelated_units: '2',
      relation_types: 'communication;host → remote',
      units: '3',
    });
    expect(rows[1]).toMatchObject({
      full_name: 'org/b',
      approach: 'single-spa',
      snapshot_apps: '6',
      units: '4',
    });
  });

  it('should write languages.csv, validation.csv, report.md and a manifest with the review hashes', async () => {
    const { config, output } = await setup(['org/a']);
    await profile({
      config,
      outputDir: output,
      token: 't',
      http: http(api()),
      run,
    });
    expect(read(output, 'languages.csv').split('\n').slice(0, 5)).toEqual([
      'id,full_name,language,group,files,bytes,share',
      '1,org/a,CSS,measured,1,10,0.250000',
      '1,org/a,JSON,excluded,1,500,',
      '1,org/a,TypeScript,measured,1,30,0.750000',
      '',
    ]);
    expect(read(output, 'validation.csv')).toBe(
      'id,full_name,measure,at,reconstructed,recorded,difference\n1,org/a,commits,2026-10-12T00:00:00.000Z,3,3,0\n',
    );
    expect(read(output, 'report.md')).toContain(
      '| stars | 1 | 0 | 3 | 3 | 3 | 0 | 3 | 3 |',
    );
    const manifest = JSON.parse(read(output, 'manifest.json'));
    expect(manifest.version).toBe('1');
    expect(manifest.configSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(manifest.reviews)).toHaveLength(2);
  });

  it('should keep the local measures and leave the API ones empty for a deleted repository', async () => {
    const { config, output } = await setup(['org/a', 'org/b']);
    await profile({
      config,
      outputDir: output,
      token: 't',
      http: http(api(['org/b'])),
      run,
    });
    const [, deleted] = await readCsvRecords(join(output, 'profile.csv'));
    expect(deleted).toMatchObject({
      full_name: 'org/b',
      files: '3',
      commits: '3',
      created_at: '',
      age_days: '',
      stars: '',
      stars_observed_at: '',
      forks: '',
      contributors: '',
      api_status: '404',
    });
    expect(read(output, 'report.md')).toContain('| stars | 1 | 1 |');
  });

  it('should leave only the failing measure empty when one endpoint answers 404', async () => {
    const { config, output } = await setup(['org/a']);
    await profile({
      config,
      outputDir: output,
      token: 't',
      http: http(api([], ['/stargazers/count'])),
      run,
    });
    const [row] = await readCsvRecords(join(output, 'profile.csv'));
    expect(row).toMatchObject({
      stars: '',
      stars_observed_at: '',
      forks: '1',
      contributors: '2',
      api_status: '200',
      age_days: '284',
    });
  });

  it('should stop without writing when every repository is unavailable', async () => {
    const { config, output } = await setup(['org/a', 'org/b']);
    await expect(
      profile({
        config,
        outputDir: output,
        token: 't',
        http: http(api(['org/a', 'org/b'])),
        run,
      }),
    ).rejects.toThrow(/all 2 repositories.*token/);
    expect(() => readFileSync(join(output, 'profile.csv'))).toThrow();
  });

  it('should rebuild the same files from the cached pages without a token or the network', async () => {
    const { config, output } = await setup();
    await profile({
      config,
      outputDir: output,
      token: 't',
      http: http(api()),
      run,
    });
    const files = [
      'profile.csv',
      'languages.csv',
      'validation.csv',
      'report.md',
      'manifest.json',
    ];
    const before = files.map((file) => read(output, file));
    const offline = vi.fn<typeof fetch>();
    const result = await profile({
      config,
      outputDir: output,
      http: http(offline),
      run,
    });
    expect(offline).not.toHaveBeenCalled();
    expect(result.fetchedPages).toBe(0);
    expect(files.map((file) => read(output, file))).toEqual(before);
  });

  it('should refuse an output made with another acquisition and leave it as it is', async () => {
    const { config, output, acquisition } = await setup();
    await profile({
      config,
      outputDir: output,
      token: 't',
      http: http(api()),
      run,
    });
    const before = read(output, 'profile.csv');
    const manifest = join(acquisition, 'manifest.json');
    writeFileSync(
      manifest,
      readFileSync(manifest, 'utf8').replace('}}', '},"other":1}'),
    );
    await expect(
      profile({
        config,
        outputDir: output,
        token: 't',
        http: http(api()),
        run,
      }),
    ).rejects.toThrow(
      /another configuration or acquisition.*config [0-9a-f]{64}.*acquisition manifest [0-9a-f]{64}/,
    );
    expect(read(output, 'profile.csv')).toBe(before);
  });

  it('should refuse an output made with another configuration', async () => {
    const { config, output } = await setup();
    await profile({
      config,
      outputDir: output,
      token: 't',
      http: http(api()),
      run,
    });
    await expect(
      profile({
        config: { ...config, version: '2' },
        outputDir: output,
        token: 't',
        http: http(api()),
        run,
      }),
    ).rejects.toThrow(/another configuration/);
  });

  it('should refuse an output directory that holds something else', async () => {
    const { config, output } = await setup();
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'notes.txt'), 'mine');
    await expect(
      profile({
        config,
        outputDir: output,
        token: 't',
        http: http(api()),
        run,
      }),
    ).rejects.toThrow(/not empty/);
  });

  it('should report the reviews that changed since the previous run', async () => {
    const { config, output, reviews } = await setup(['org/a']);
    await profile({
      config,
      outputDir: output,
      token: 't',
      http: http(api()),
      run,
    });
    reviewFile(join(reviews, 'structure'), '001.md', 'org/a', 'Apps: 9');
    const result = await profile({
      config,
      outputDir: output,
      http: http(vi.fn()),
      run,
    });
    expect(result.changedReviews).toEqual([
      join(reviews, 'structure', '001.md'),
    ]);
    expect(
      (await readCsvRecords(join(output, 'profile.csv')))[0]?.snapshot_apps,
    ).toBe('9');
  });

  it('should check the reviews before asking the API for anything', async () => {
    const { config, output } = await setup(['org/a'], { status: 'draft' });
    const fetchFn = api();
    await expect(
      profile({
        config,
        outputDir: output,
        token: 't',
        http: http(fetchFn),
        run,
      }),
    ).rejects.toThrow(/draft/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('should ask for the token when a page is missing', async () => {
    const { config, output } = await setup(['org/a']);
    await expect(
      profile({ config, outputDir: output, http: http(api()), run }),
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('should keep the pages already fetched when the API fails and go on from there', async () => {
    const { config, output } = await setup(['org/a', 'org/b']);
    const good = api();
    let calls = 0;
    const flaky = vi.fn<typeof fetch>(async (input, init) => {
      calls += 1;
      if (calls > 4) return json({ message: 'broken' }, 422);
      return good(input, init);
    });
    await expect(
      profile({
        config,
        outputDir: output,
        token: 't',
        http: http(flaky),
        run,
      }),
    ).rejects.toThrow(/422/);
    const resumed = api();
    const result = await profile({
      config,
      outputDir: output,
      token: 't',
      http: http(resumed),
      run,
    });
    expect(result.fetchedPages).toBe(4);
    expect(resumed).toHaveBeenCalledTimes(4);
  });

  it('should compare the stars and forks with what the discovery recorded', async () => {
    const root = temporaryDirectory();
    mkdirSync(root, { recursive: true });
    const discovery = join(root, 'round');
    mkdirSync(discovery);
    await writeCsv(
      join(discovery, 'candidates.csv'),
      ['id', 'full_name', 'evidence_json'],
      [
        [
          '1',
          'org/a',
          JSON.stringify({
            observations: [
              {
                status: 'ok',
                observedAt: '2026-10-08T00:00:00Z',
                data: { stargazerCount: 5 },
              },
            ],
          }),
        ],
      ],
    );
    const { config, output } = await setup(['org/a'], {
      overrides: { validation: { discovery } },
    });
    const result = await profile({
      config,
      outputDir: output,
      token: 't',
      http: http(api()),
      run,
    });
    expect(result.validationDifferences).toBe(1);
    const rows = await readCsvRecords(join(output, 'validation.csv'));
    expect(rows[0]).toMatchObject({
      measure: 'stars',
      at: '2026-10-08T00:00:00Z',
      reconstructed: '3',
      recorded: '5',
      difference: '-2',
    });
  });

  it('should leave the previous outputs intact when writing fails', async () => {
    const { config, output } = await setup(['org/a']);
    await profile({
      config,
      outputDir: output,
      token: 't',
      http: http(api()),
      run,
    });
    const files = [
      'profile.csv',
      'languages.csv',
      'validation.csv',
      'report.md',
      'manifest.json',
    ];
    const before = files.map((file) => read(output, file));
    failure.on = true;
    await expect(
      profile({ config, outputDir: output, http: http(vi.fn()), run }),
    ).rejects.toThrow(/disk full/);
    failure.on = false;
    expect(files.map((file) => read(output, file))).toEqual(before);
    expect(() =>
      readFileSync(join(output, '.staging', 'profile.csv')),
    ).toThrow();
  });
});
