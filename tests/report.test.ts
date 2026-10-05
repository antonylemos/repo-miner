import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportRun } from '../src/discovery/report.js';
import type { SearchHit, Subquery } from '../src/discovery/types.js';
import {
  catalogOf,
  cleanupTestStores,
  createTestStore,
  hit,
  page,
  parseCsv,
  query,
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
        row.enrichment_status,
        row.strategies,
      ]),
    ).toEqual([
      ['1', 'in_scope', 'search', '', 'terminology;technology'],
      ['2', 'out_of_scope_temporal', 'search', '', 'terminology'],
      ['3', 'in_scope', 'enrichment', 'ok', 'technology'],
      ['4', 'unknown', '', 'pending', 'technology'],
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

  it('should report enrichment status, limitations and the absence of confirmed implementations', async () => {
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
    expect(report).toContain('Web Components');
    expect(report).toContain(
      'Contagens de implementações confirmadas não estão disponíveis',
    );
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
