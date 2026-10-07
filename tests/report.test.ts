import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { exportRun } from '../src/discovery/report.js';
import { openStore } from '../src/discovery/storage.js';
import type { SearchHit, Subquery } from '../src/discovery/types.js';
import {
  catalogOf,
  cleanupTestStores,
  createTestStore,
  hit,
  page,
  parseCsv,
  query,
  trackStore,
} from './helpers.js';

const terminology = query({ id: 'query-a' });
const technology = query({
  id: 'query-b',
  strategy: 'technology',
  endpoint: 'code',
  q: 'single-spa filename:package.json',
  partition: { by: 'size', bounds: [0, 1000] },
});
const broader = query({ id: 'query-c', strategy: 'broader' });
const catalog = catalogOf([terminology, technology, broader]);

afterEach(cleanupTestStores);

function setup() {
  const context = createTestStore(catalog);
  const byId = new Map(context.subqueries.map((s) => [s.id, s]));
  const save = (
    id: string,
    hits: SearchHit[],
    state: 'complete' | 'partial' = 'complete',
    reason?: string,
  ) => {
    const subquery = byId.get(id) as Subquery;
    const checkpoint = { subqueryId: id, nextPage: null, state } as const;
    context.store.savePage(
      subquery,
      1,
      page(hits),
      checkpoint,
      `fetched-${id}`,
    );
    if (reason) context.store.markSubquery(checkpoint, reason);
  };
  return { ...context, save };
}

function readCsv(dir: string, name: string) {
  const [header, ...rows] = parseCsv(readFileSync(join(dir, name), 'utf8'));
  return rows.map((row) =>
    Object.fromEntries(header.map((column, index) => [column, row[index]])),
  );
}

describe('exportRun', () => {
  it('should export a coherent snapshot while another connection commits page ten', async () => {
    const { directory, store, subqueries } = createTestStore(
      catalogOf([query({ id: 'repo' })]),
    );
    const writer = trackStore(openStore(join(directory, 'discovery.sqlite')));
    const subquery = subqueries[0];
    const metadata = {
      pushed_at: '2025-01-01T00:00:00Z',
      description: 'x'.repeat(350),
      topics: ['microfrontends', 'shell'],
    };
    for (let number = 1; number <= 9; number += 1) {
      writer.savePage(
        subquery,
        number,
        page(
          Array.from({ length: 100 }, (_, offset) =>
            hit((number - 1) * 100 + offset + 1, { metadata }),
          ),
          { hasNext: true, totalCount: 901 },
        ),
        { subqueryId: subquery.id, nextPage: number + 1, state: 'pending' },
        `page-${number}`,
      );
    }

    const iterate = store.iterateCandidates.bind(store);
    let active = false;
    let produced = 0;
    let writeError: unknown;
    let resolveWrite!: () => void;
    const written = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    store.readCandidates = () => {
      throw new Error('Export must stream candidates');
    };
    store.iterateCandidates = function* () {
      active = true;
      try {
        for (const candidate of iterate()) {
          produced += 1;
          if (produced === 20) {
            queueMicrotask(() => {
              try {
                expect(active).toBe(true);
                expect(produced).toBeLessThan(900);
                writer.savePage(
                  subquery,
                  10,
                  page([hit(901, { metadata })], { totalCount: 901 }),
                  {
                    subqueryId: subquery.id,
                    nextPage: null,
                    state: 'complete',
                  },
                  'page-10',
                );
                writer.finish({
                  run: {
                    ...writer.getRun(),
                    state: 'complete',
                    endedAt: 'finished-at',
                  },
                  coverage: writer.readCoverage(),
                });
              } catch (error) {
                writeError = error;
              } finally {
                resolveWrite();
              }
            });
          }
          yield candidate;
        }
      } finally {
        active = false;
      }
    };

    const first = await exportRun(store, directory);
    await written;
    expect(writeError).toBeUndefined();
    expect(writer.getCheckpoint(subquery.id)).toEqual({
      subqueryId: subquery.id,
      nextPage: null,
      state: 'complete',
    });
    expect(writer.readCandidates()).toHaveLength(901);
    const candidateCsvRows = readCsv(directory, 'candidates.csv');
    const hitCsvRows = readCsv(directory, 'discovery-hits.csv');
    expect(candidateCsvRows).toHaveLength(900);
    expect(hitCsvRows).toHaveLength(900);
    expect(
      candidateCsvRows.every(
        (row) => row.scope === 'in_scope' && row.strategies === 'terminology',
      ),
    ).toBe(true);
    expect(candidateCsvRows.at(-1)?.id).toBe('900');
    expect(hitCsvRows.at(-1)?.candidate_id).toBe('900');
    const coverage = JSON.parse(
      readFileSync(join(directory, 'coverage.json'), 'utf8'),
    );
    expect(coverage.totals).toEqual({ hits: 900, uniqueCandidates: 900 });
    expect(coverage.subqueries[0]).toMatchObject({
      fetchedPages: 9,
      state: 'pending',
      totalReported: 901,
    });
    expect(coverage.run.state).toBe('running');
    expect(coverage.byScope).toEqual({
      in_scope: 900,
      out_of_scope_temporal: 0,
      unknown: 0,
    });
    expect(coverage.byStrategy.all).toEqual({
      terminology: 900,
      technology: 0,
      broader: 0,
    });
    expect(coverage.queries[0]).toMatchObject({
      pending: 1,
      complete: 0,
      hits: 900,
      uniqueCandidates: 900,
    });
    const report = readFileSync(join(directory, 'report.md'), 'utf8');
    expect(report).toContain('Estado: running');
    expect(report).toContain('Fim: em andamento');
    expect(report).toContain(
      'Hits coletados: 900. Repositórios distintos: 900.',
    );
    expect(report).toContain('| terminology | 900 | 900 |');
    const manifest = JSON.parse(
      readFileSync(join(directory, 'manifest.json'), 'utf8'),
    );
    expect(manifest.run.endedAt).toBeNull();
    for (const file of first.files) {
      if (file.endsWith('manifest.json')) continue;
      expect(manifest.sha256[file.split('/').at(-1) as string]).toBe(
        createHash('sha256').update(readFileSync(file)).digest('hex'),
      );
    }

    await exportRun(store, directory);
    expect(readCsv(directory, 'candidates.csv')).toHaveLength(901);
    expect(readCsv(directory, 'discovery-hits.csv')).toHaveLength(901);
    const after = JSON.parse(
      readFileSync(join(directory, 'coverage.json'), 'utf8'),
    );
    expect(after.totals).toEqual({ hits: 901, uniqueCandidates: 901 });
    expect(after.subqueries[0].state).toBe('complete');
    expect(after.run).toMatchObject({
      state: 'complete',
      endedAt: 'finished-at',
    });
  });

  it('should release a read snapshot after CSV write failure', async () => {
    const { directory, store, subqueries } = createTestStore(
      catalogOf([query({ id: 'repo' })]),
    );
    const subquery = subqueries[0];
    const writer = trackStore(openStore(join(directory, 'discovery.sqlite')));
    writer.savePage(
      subquery,
      1,
      page(
        Array.from({ length: 900 }, (_, id) =>
          hit(id + 1, { metadata: { description: 'x'.repeat(350) } }),
        ),
      ),
      { subqueryId: subquery.id, nextPage: 2, state: 'pending' },
      'at',
    );
    const iterate = store.iterateCandidates.bind(store);
    let closed = false;
    let produced = 0;
    store.iterateCandidates = function* () {
      try {
        for (const candidate of iterate()) {
          produced += 1;
          yield candidate;
        }
      } finally {
        closed = true;
      }
    };
    const output = join(directory, 'failed-export');
    mkdirSync(join(output, 'candidates.csv'), { recursive: true });
    await expect(exportRun(store, output)).rejects.toThrow();
    expect(produced).toBeGreaterThan(0);
    expect(produced).toBeLessThan(900);
    expect(closed).toBe(true);
    expect(
      await store.withReadSnapshot(
        async (snapshot) => snapshot.readCandidates().length,
      ),
    ).toBe(900);
    writer.savePage(
      subquery,
      2,
      page([hit(901)]),
      { subqueryId: subquery.id, nextPage: null, state: 'complete' },
      'later',
    );
    expect(
      await store.withReadSnapshot(
        async (snapshot) => snapshot.readCandidates().length,
      ),
    ).toBe(901);
  });

  it('should report superseded historical failures without updating the persisted run', async () => {
    const { directory, store, subqueries } = createTestStore(
      catalogOf([
        query({ id: 'repo' }),
        query({ id: 'code', endpoint: 'code' }),
      ]),
    );
    store.savePage(
      subqueries[1],
      1,
      page([hit(1, { metadata: {} })]),
      { subqueryId: 'code', nextPage: null, state: 'complete' },
      'code-at',
    );
    store.queueEnrichment();
    store.saveEnrichments(
      [
        {
          repositoryId: 1,
          status: 'failed',
          data: null,
          reason: 'GraphQL unavailable',
        },
      ],
      'failed-at',
    );
    store.savePage(
      subqueries[0],
      1,
      page([hit(1)]),
      { subqueryId: 'repo', nextPage: null, state: 'complete' },
      'rest-at',
    );
    store.finish({
      run: { ...store.getRun(), state: 'partial', endedAt: 'old-end' },
      coverage: store.readCoverage(),
    });
    const persisted = store.getRun();
    await exportRun(store, directory);
    const coverage = JSON.parse(
      readFileSync(join(directory, 'coverage.json'), 'utf8'),
    );
    expect(coverage.enrichment).toEqual({
      pending: 0,
      ok: 0,
      not_found: 0,
      failed: 1,
    });
    expect(coverage.enrichmentRequired).toEqual({ pending: 0, failed: 0 });
    expect(coverage.enrichmentSuperseded).toEqual({ pending: 0, failed: 1 });
    expect(readCsv(directory, 'candidates.csv')[0]).toMatchObject({
      scope: 'in_scope',
      enrichment_status: 'failed',
      pushed_at_source: 'search',
    });
    const report = readFileSync(join(directory, 'report.md'), 'utf8');
    expect(report).toContain('| failed | 1 |');
    expect(report).toContain('Necessários: pending=0; failed=0');
    expect(report).toContain(
      'Dispensados por metadados de busca: pending=0; failed=1',
    );
    expect(store.getRun()).toEqual(persisted);
    expect(store.readCandidates()[0].enrichment?.reason).toBe(
      'GraphQL unavailable',
    );
  });

  it('should recover REST metadata from a v2 file without changing original records', async () => {
    const sourceCatalog = catalogOf(
      [query({ id: 'repo' }), query({ id: 'code', endpoint: 'code' })],
      '2025-04-01',
    );
    const { directory, store, subqueries } = createTestStore(sourceCatalog);
    const metadata = {
      pushed_at: '2026-10-01T00:00:00Z',
      description: 'shell',
      topics: ['example'],
      license: { spdx_id: 'MIT' },
    };
    store.savePage(
      subqueries[1],
      1,
      page([hit(1, { path: 'package.json', metadata: {} })]),
      { subqueryId: 'code', nextPage: null, state: 'complete' },
      '2026-10-06T10:00:00Z',
    );
    store.savePage(
      subqueries[0],
      1,
      page([hit(1, { metadata })]),
      { subqueryId: 'repo', nextPage: null, state: 'complete' },
      '2026-10-06T10:01:00Z',
    );
    const originalRun = store.getRun();
    store.close();
    const path = join(directory, 'discovery.sqlite');
    const raw = new DatabaseSync(path);
    // Existing v2 files predate the observation index.
    raw.exec('DROP INDEX IF EXISTS hits_repository_observation');
    const records = () =>
      [
        'candidates',
        'hits',
        'pages',
        'runs',
        'queries',
        'subqueries',
        'checkpoints',
        'enrichments',
      ].map((table) =>
        raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
    const schema = () =>
      raw
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE name != 'hits_repository_observation' ORDER BY name",
        )
        .all();
    const before = records();
    const beforeSchema = schema();
    const reopened = trackStore(openStore(path));
    expect(reopened.getRun()).toEqual(originalRun);
    expect(reopened.getCatalog()).toEqual(sourceCatalog);
    expect(reopened.readCandidates()[0]).toMatchObject({
      metadata,
      metadataObservedAt: '2026-10-06T10:01:00Z',
      firstSeenAt: '2026-10-06T10:00:00Z',
    });
    await exportRun(reopened, directory);
    const [row] = readCsv(directory, 'candidates.csv');
    expect(JSON.parse(row.metadata_json)).toEqual(metadata);
    expect(row.pushed_at_observed_at).toBe('2026-10-06T10:01:00Z');
    expect(row.pushed_at_source).toBe('search');
    expect(row.scope).toBe('in_scope');
    expect(records()).toEqual(before);
    expect(schema()).toEqual(beforeSchema);
    expect(
      raw
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name = 'hits_repository_observation'",
        )
        .get(),
    ).toHaveProperty(
      'sql',
      expect.stringContaining('(repository_id, fetched_at, subquery_id, path)'),
    );
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({
      user_version: 2,
    });
    raw.close();
  });

  it('should export each candidate once with scope and discovering strategies', async () => {
    const { directory, store, save } = setup();
    save('query-a', [
      hit(1),
      hit(2, { metadata: { pushed_at: '2023-06-01T00:00:00Z' } }),
    ]);
    save('query-b#size:0..999', [
      hit(1, { path: 'package.json' }),
      hit(3, { path: 'package.json', metadata: { fork: false } }),
      hit(4, { path: 'package.json', metadata: { fork: false } }),
    ]);
    store.queueEnrichment();
    store.saveEnrichments(
      [
        {
          repositoryId: 3,
          status: 'ok',
          data: { pushedAt: '2025-03-01T00:00:00Z' },
          reason: null,
        },
      ],
      'enriched-at',
    );

    await exportRun(store, directory);

    const rows = readCsv(directory, 'candidates.csv');
    expect(
      rows.map((row) => [
        row.id,
        row.scope,
        row.pushed_at_source,
        row.pushed_at_observed_at,
        row.enrichment_status,
        row.strategies,
      ]),
    ).toEqual([
      [
        '1',
        'in_scope',
        'search',
        'fetched-query-a',
        '',
        'terminology;technology',
      ],
      [
        '2',
        'out_of_scope_temporal',
        'search',
        'fetched-query-a',
        '',
        'terminology',
      ],
      ['3', 'in_scope', 'enrichment', 'enriched-at', 'ok', 'technology'],
      ['4', 'unknown', '', '', 'pending', 'technology'],
    ]);
    expect(JSON.parse(rows[2].enrichment_json)).toEqual({
      pushedAt: '2025-03-01T00:00:00Z',
    });
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

  it('should compute exclusive, pairwise and triple intersections over in-scope candidates', async () => {
    const { directory, store, save } = setup();
    const old = { metadata: { pushed_at: '2020-01-01T00:00:00Z' } };
    save('query-a', [hit(1), hit(2), hit(3), hit(9, old)]);
    save('query-b#size:0..999', [hit(1, { path: 'p' }), hit(2, { path: 'p' })]);
    save('query-c', [hit(1), hit(9, old)]);

    await exportRun(store, directory);

    const coverage = JSON.parse(
      readFileSync(join(directory, 'coverage.json'), 'utf8'),
    );
    expect(coverage.intersections).toEqual({
      exclusive: { terminology: 1, technology: 0, broader: 0 },
      pairs: [
        { left: 'terminology', right: 'technology', count: 2 },
        { left: 'terminology', right: 'broader', count: 1 },
        { left: 'technology', right: 'broader', count: 1 },
      ],
      all: 1,
    });
    expect(coverage.byScope).toEqual({
      in_scope: 3,
      out_of_scope_temporal: 1,
      unknown: 0,
    });
    expect(coverage.byStrategy.inScope).toEqual({
      terminology: 3,
      technology: 2,
      broader: 1,
    });
    expect(coverage.byStrategy.all.broader).toBe(2);
    const report = readFileSync(join(directory, 'report.md'), 'utf8');
    expect(report).toContain('- somente terminology: 1');
    expect(report).toContain('- terminology ∩ technology: 2 repositórios');
    expect(report).toContain(
      '- terminology ∩ technology ∩ broader: 1 repositórios',
    );
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

    const coverage = JSON.parse(
      readFileSync(join(directory, 'coverage.json'), 'utf8'),
    );
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
    const report = readFileSync(join(directory, 'report.md'), 'utf8');
    expect(report).toContain(
      '| query-b#size:0..999 | partial | result cap reached |',
    );
    expect(report).toContain('| query-c | failed | temporary error |');
    expect(report).toContain('Recorte temporal: pushed >= 2024-01-01');
  });

  it('should report enrichment status, generic limitations and the absence of confirmed cases', async () => {
    const { directory, store, save } = setup();
    save('query-b#size:0..999', [hit(5, { path: 'p', metadata: {} })]);
    store.queueEnrichment();
    store.saveEnrichments(
      [{ repositoryId: 5, status: 'not_found', data: null, reason: 'gone' }],
      't',
    );

    await exportRun(store, directory);

    const report = readFileSync(join(directory, 'report.md'), 'utf8');
    expect(report).toContain('| not_found | 1 |');
    expect(report).toContain('forks');
    expect(report).toContain('384 KB');
    expect(report).toContain(
      'Contagens de casos confirmados não estão disponíveis',
    );
    // The tool is domain-agnostic: study-specific caveats live in the use-case docs.
    expect(report).not.toMatch(/web components|micro-?frontends?|\bMFE\b/i);
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

  it('should record run parameters, git state and hashes of every exported file', async () => {
    const { directory, store } = setup();

    const result = await exportRun(store, directory);

    const manifest = JSON.parse(
      readFileSync(join(directory, 'manifest.json'), 'utf8'),
    );
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.run).toMatchObject({
      id: store.getRun().id,
      catalogHash: store.getRun().catalogHash,
      pushedSince: '2024-01-01',
      expansionDate: '2026-10-05',
    });
    expect(manifest.versions.node).toBe(process.version);
    expect(manifest.versions.lockfileVersion).toBe('9.0');
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

it('pins the exact legacy fixture CSV and manifest structure after common extraction', async () => {
  const { directory, store, subqueries } = createTestStore(
    catalogOf([query({ id: 'repo' })]),
  );
  store.savePage(
    subqueries[0],
    1,
    page([hit(1)]),
    { subqueryId: 'repo', nextPage: null, state: 'complete' },
    'at',
  );
  await exportRun(store, directory);
  expect(readFileSync(join(directory, 'candidates.csv'), 'utf8')).toBe(
    'id,full_name,url,scope,pushed_at,pushed_at_source,pushed_at_observed_at,enrichment_status,strategies,metadata_json,enrichment_json\n1,org/repo-1,https://github.com/org/repo-1,in_scope,2025-01-01T00:00:00Z,search,at,,terminology,"{""pushed_at"":""2025-01-01T00:00:00Z""}",\n',
  );
  expect(readFileSync(join(directory, 'discovery-hits.csv'), 'utf8')).toBe(
    'query_id,subquery_id,strategy,endpoint,q_effective,fetched_at,candidate_id,full_name,repository_url,path,url\nrepo,repo,terminology,repositories,repo pushed:>=2024-01-01,at,1,org/repo-1,https://github.com/org/repo-1,,https://github.com/org/repo-1\n',
  );
  const manifest = JSON.parse(
    readFileSync(join(directory, 'manifest.json'), 'utf8'),
  );
  expect(Object.keys(manifest)).toEqual([
    'schemaVersion',
    'run',
    'versions',
    'git',
    'sha256',
  ]);
  expect(manifest.run).toEqual({
    id: store.getRun().id,
    startedAt: '2026-10-05T00:00:00.000Z',
    endedAt: null,
    catalogHash: store.getRun().catalogHash,
    pushedSince: '2024-01-01',
    expansionDate: '2026-10-05',
  });
  expect(Object.keys(manifest.versions)).toEqual([
    'node',
    'code',
    'lockfileVersion',
    'lockfileSha256',
  ]);
  expect(Object.keys(manifest.sha256)).toEqual([
    'candidates.csv',
    'discovery-hits.csv',
    'coverage.json',
    'report.md',
  ]);
});
