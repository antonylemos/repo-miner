import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSearchStore,
  hit,
  page,
  parseCsv,
  query,
} from '@tests/helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { SearchHit, Subquery } from '@/modules/discovery/model/search.js';
import type { DiscoveryStore } from '@/modules/discovery/model/store.js';
import { exportRun } from '@/modules/discovery/report/export.js';

const terminology = query({ id: 'query-a' });
const technology = query({
  id: 'query-b',
  strategy: 'technology',
  endpoint: 'code',
  q: 'single-spa filename:package.json',
  partition: { by: 'size', bounds: [0, 1000] },
});
const broader = query({ id: 'query-c', strategy: 'broader' });
const stores: DiscoveryStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const { store, subqueries } = createSearchStore([
    terminology,
    technology,
    broader,
  ]);
  stores.push(store);
  const directory = mkdtempSync(join(tmpdir(), 'report-export-'));
  directories.push(directory);
  const byId = new Map(subqueries.map((s) => [s.id, s]));
  const save = (
    id: string,
    hits: SearchHit[],
    state: 'complete' | 'partial' = 'complete',
    reason?: string,
  ) => {
    const subquery = byId.get(id) as Subquery;
    const checkpoint = { subqueryId: id, nextPage: null, state } as const;
    store.savePage(subquery, 1, page(hits), checkpoint, `fetched-${id}`);
    if (reason) store.markSubquery(checkpoint, reason);
  };
  return { directory, store, save };
}

function readCsv(dir: string, name: string) {
  const [header, ...rows] = parseCsv(readFileSync(join(dir, name), 'utf8'));
  return rows.map((row) =>
    Object.fromEntries(header.map((column, index) => [column, row[index]])),
  );
}
const readJson = (dir: string, name: string) =>
  JSON.parse(readFileSync(join(dir, name), 'utf8'));

describe('exportRun without rules', () => {
  it('should export each candidate once with its discovering strategies', async () => {
    const { directory, store, save } = setup();
    save('query-a', [hit(1), hit(2)]);
    save('query-b#size:0..999', [
      hit(1, { path: 'package.json' }),
      hit(3, { path: 'package.json' }),
    ]);

    await exportRun(store, directory);

    expect(
      readCsv(directory, 'candidates.csv').map((row) => [
        row.id,
        row.strategies,
      ]),
    ).toEqual([
      ['1', 'terminology;technology'],
      ['2', 'terminology'],
      ['3', 'technology'],
    ]);
  });

  it('should export the provenance fields of every hit', async () => {
    const { directory, store, save } = setup();
    save('query-b#size:0..999', [
      hit(1, { path: 'src/one.ts' }),
      hit(1, { path: 'src/two.ts' }),
    ]);

    await exportRun(store, directory);

    const rows = readCsv(directory, 'discovery-hits.csv');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      query_id: 'query-b',
      subquery_id: 'query-b#size:0..999',
      strategy: 'technology',
      endpoint: 'code',
      q_effective: 'single-spa filename:package.json size:0..999',
      fetched_at: 'fetched-query-b#size:0..999',
      candidate_id: '1',
      path: 'src/one.ts',
    });
  });

  it('should escape commas quotes Unicode and line breaks in CSV fields', async () => {
    const { directory, store, save } = setup();
    const special = hit(3, { path: 'src/ação,"component"\nnext.ts' });
    special.candidate.fullName = 'org/ação,"repo"\nnext-line';
    save('query-b#size:0..999', [special]);

    await exportRun(store, directory);

    expect(readFileSync(join(directory, 'candidates.csv'), 'utf8')).toContain(
      '"org/ação,""repo""\nnext-line"',
    );
    expect(readCsv(directory, 'discovery-hits.csv')[0].path).toBe(
      'src/ação,"component"\nnext.ts',
    );
  });

  it('should compute exclusive, pairwise and triple intersections', async () => {
    const { directory, store, save } = setup();
    save('query-a', [hit(1), hit(2), hit(3)]);
    save('query-b#size:0..999', [hit(1, { path: 'p' }), hit(2, { path: 'p' })]);
    save('query-c', [hit(1)]);

    await exportRun(store, directory);

    const coverage = readJson(directory, 'coverage.json');
    expect(coverage.intersections.all).toEqual({
      exclusive: { terminology: 1, technology: 0, broader: 0 },
      pairs: [
        { left: 'terminology', right: 'technology', count: 2 },
        { left: 'terminology', right: 'broader', count: 1 },
        { left: 'technology', right: 'broader', count: 1 },
      ],
      all: 1,
    });
    expect(coverage.byStrategy.all).toEqual({
      terminology: 3,
      technology: 2,
      broader: 1,
    });
  });

  it('should aggregate coverage by source query and list saturated subqueries', async () => {
    const { directory, store, save } = setup();
    save(
      'query-b#size:0..999',
      [hit(1, { path: 'p' })],
      'partial',
      'result cap reached',
    );
    save('query-b#size:>=1000', [hit(2, { path: 'p' })]);
    store.markSubquery(
      { subqueryId: 'query-c', nextPage: 1, state: 'failed' },
      'temporary error',
    );

    await exportRun(store, directory);

    const coverage = readJson(directory, 'coverage.json');
    expect(
      coverage.queries.find(
        (q: { queryId: string }) => q.queryId === 'query-b',
      ),
    ).toMatchObject({
      subqueries: 2,
      complete: 1,
      partial: 1,
      failed: 0,
      pending: 0,
      hits: 2,
      uniqueCandidates: 2,
    });
    expect(coverage.subqueries).toHaveLength(4);
  });

  it('should export only the analysis fields of the search metadata', async () => {
    const { directory, store, save } = setup();
    save('query-a', [
      hit(1, {
        metadata: {
          pushed_at: '2025-01-01T00:00:00Z',
          description: 'shell',
          topics: ['microfrontends'],
          stargazers_count: 7,
          fork: false,
          owner: { login: 'org' },
          issues_url: 'https://api.github.com/repos/org/repo-1/issues{/number}',
        },
      }),
    ]);

    await exportRun(store, directory);

    expect(
      JSON.parse(readCsv(directory, 'candidates.csv')[0].metadata_json),
    ).toEqual({
      description: 'shell',
      topics: ['microfrontends'],
      pushed_at: '2025-01-01T00:00:00Z',
      stargazers_count: 7,
      fork: false,
    });
  });

  it('should keep repository metadata out of the hits export', async () => {
    const { directory, store, save } = setup();
    save('query-a', [hit(1, { metadata: { description: 'x'.repeat(100) } })]);

    await exportRun(store, directory);

    const [header] = readFileSync(
      join(directory, 'discovery-hits.csv'),
      'utf8',
    ).split('\n');
    expect(header).toBe(
      'query_id,subquery_id,strategy,endpoint,q_effective,fetched_at,candidate_id,full_name,repository_url,path,url',
    );
    expect(readCsv(directory, 'candidates.csv')[0].metadata_json).toContain(
      'x'.repeat(100),
    );
  });

  it('should report each export step until all files are written', async () => {
    const { directory, store } = setup();
    const steps: string[] = [];

    await exportRun(store, directory, (done, total, label) =>
      steps.push(`${done}/${total} ${label}`.trim()),
    );

    expect(steps).toEqual([
      '0/6 lendo dados',
      '1/6 candidates.csv',
      '2/6 discovery-hits.csv',
      '3/6 coverage.json',
      '4/6 report.md',
      '5/6 manifest.json',
      '6/6',
    ]);
  });

  it('should keep the report free of study-specific vocabulary', async () => {
    const { directory, store, save } = setup();
    save('query-a', [hit(1)]);

    await exportRun(store, directory);

    const report = readFileSync(join(directory, 'report.md'), 'utf8');
    expect(report).toContain('384 KB');
    expect(report).not.toMatch(/web components|micro-?frontends?|\bMFE\b/i);
  });

  it('should record the git state and the hash of every exported file', async () => {
    const { directory, store } = setup();

    const result = await exportRun(store, directory);

    const manifest = readJson(directory, 'manifest.json');
    expect(manifest.run).toMatchObject({
      id: store.getRun().id,
      catalogHash: store.getRun().catalogHash,
      expansionDate: '2026-10-05',
    });
    expect(manifest.versions.node).toBe(process.version);
    if (manifest.git.available) {
      expect(typeof manifest.git.dirty).toBe('boolean');
    } else {
      expect(manifest.git.reason).toBeTruthy();
    }
    for (const file of result.files) {
      if (file.endsWith('manifest.json')) continue;
      const name = file.split('/').at(-1) as string;
      expect(manifest.sha256[name]).toBe(
        createHash('sha256').update(readFileSync(file)).digest('hex'),
      );
    }
  });
});

describe('exportRun with study-defined strategy labels', () => {
  function labelled(labels: string[]) {
    const { store, subqueries } = createSearchStore(
      labels.map((strategy, index) =>
        query({ id: `q${index}`, strategy, q: `term${index}` }),
      ),
    );
    stores.push(store);
    const directory = mkdtempSync(join(tmpdir(), 'report-labels-'));
    directories.push(directory);
    for (const [index, subquery] of subqueries.entries())
      store.savePage(
        subquery,
        1,
        page([hit(1), ...(index === 0 ? [hit(2)] : [])]),
        { subqueryId: subquery.id, nextPage: null, state: 'complete' },
        't',
      );
    return { store, directory };
  }

  it('should use the catalog labels in every output and none of the study vocabulary', async () => {
    const { store, directory } = labelled(['alpha', 'beta-two']);

    await exportRun(store, directory);

    expect(
      readCsv(directory, 'candidates.csv').map((row) => row.strategies),
    ).toEqual(['alpha;beta-two', 'alpha']);
    const coverage = readJson(directory, 'coverage.json');
    expect(coverage.byStrategy.all).toEqual({ alpha: 2, 'beta-two': 1 });
    expect(coverage.intersections.all.pairs).toEqual([
      { left: 'alpha', right: 'beta-two', count: 1 },
    ]);
    const report = readFileSync(join(directory, 'report.md'), 'utf8');
    expect(report).toContain('| alpha | 2 |');
    expect(report).toContain('- somente alpha: 1');
    expect(report).toContain('- alpha ∩ beta-two: 1 repositórios');
    for (const name of [
      'candidates.csv',
      'discovery-hits.csv',
      'coverage.json',
      'report.md',
    ])
      expect(readFileSync(join(directory, name), 'utf8')).not.toMatch(
        /terminology|technology|broader/,
      );
  });

  it('should report a single label without pair intersections', async () => {
    const { store, directory } = labelled(['solo']);

    await exportRun(store, directory);

    const coverage = readJson(directory, 'coverage.json');
    expect(coverage.byStrategy.all).toEqual({ solo: 2 });
    expect(coverage.intersections.all.pairs).toEqual([]);
    expect(readFileSync(join(directory, 'report.md'), 'utf8')).not.toContain(
      '∩',
    );
  });

  it('should report four labels with six pair intersections', async () => {
    const { store, directory } = labelled(['a', 'b', 'c', 'd']);

    await exportRun(store, directory);

    const coverage = readJson(directory, 'coverage.json');
    expect(coverage.intersections.all.pairs).toHaveLength(6);
    expect(
      readFileSync(join(directory, 'report.md'), 'utf8').match(
        / ∩ \w+: \d+ rep/g,
      ),
    ).toHaveLength(7);
  });
});
