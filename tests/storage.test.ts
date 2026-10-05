import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogHash } from '../src/discovery/catalog.js';
import { openStore } from '../src/discovery/storage.js';
import {
  catalogOf,
  cleanupTestStores,
  createTestStore,
  hit,
  page,
  query,
  trackStore,
} from './helpers.js';

const repositoryQuery = query({
  id: 'repository-query',
  q: 'microfrontend in:readme',
  partition: { by: 'created', from: '2026-09-01', interval: 'month' },
});
const codeQuery = query({
  id: 'code-query',
  strategy: 'technology',
  endpoint: 'code',
  q: 'single-spa filename:package.json',
});
const catalog = catalogOf([repositoryQuery, codeQuery]);

afterEach(cleanupTestStores);

function complete(subqueryId: string) {
  return { subqueryId, nextPage: null, state: 'complete' as const };
}

describe('discovery storage', () => {
  it('should persist subqueries in expansion order with their source query', () => {
    const { store, subqueries } = createTestStore(catalog);

    expect(store.getSubqueries()).toEqual(subqueries);
    expect(store.getSubqueries().map((s) => s.id)).toEqual([
      'repository-query#created:<2026-09-01',
      'repository-query#created:2026-09',
      'repository-query#created:>=2026-10-01',
      'code-query',
    ]);
    expect(store.getRun()).toMatchObject({
      pushedSince: '2024-01-01',
      expansionDate: '2026-10-05',
    });
  });

  it('should rebuild the stored catalog with the same hash', () => {
    const { store } = createTestStore(catalog);

    expect(store.getCatalog()).toEqual(catalog);
    expect(catalogHash(store.getCatalog())).toBe(store.getRun().catalogHash);
  });

  it('should keep one candidate with every subquery origin and fetch time', () => {
    const { store, subqueries } = createTestStore(catalog);
    const [first, second] = subqueries;
    const code = subqueries[3];
    store.savePage(first, 1, page([hit(101)]), complete(first.id), 't1');
    store.savePage(second, 1, page([hit(101)]), complete(second.id), 't2');
    store.savePage(
      code,
      1,
      page([hit(101, { path: 'package.json' })]),
      complete(code.id),
      't3',
    );

    expect(store.readCandidates()).toHaveLength(1);
    expect(store.readCandidates()[0]).toMatchObject({
      id: 101,
      nodeId: 'R_101',
      firstSeenAt: 't1',
      enrichment: null,
    });
    expect(
      store
        .readHits()
        .map((h) => [h.queryId, h.subqueryId, h.fetchedAt, h.qEffective]),
    ).toEqual([
      ['code-query', 'code-query', 't3', 'single-spa filename:package.json'],
      // Binary collation sorts "created:2026-09" before "created:<2026-09-01".
      ['repository-query', second.id, 't2', second.q],
      ['repository-query', first.id, 't1', first.q],
    ]);
  });

  it('should keep distinct normalized code paths for the same repository', () => {
    const { store, subqueries } = createTestStore(catalog);
    const code = subqueries[3];
    store.savePage(
      code,
      1,
      page([
        hit(202, { path: './src/../src/App.tsx' }),
        hit(202, { path: 'src/remote.ts' }),
      ]),
      complete(code.id),
      't',
    );

    expect(
      store
        .readHits()
        .map((h) => h.path)
        .sort(),
    ).toEqual(['src/App.tsx', 'src/remote.ts']);
  });

  it('should make replaying a committed page idempotent', () => {
    const { store, subqueries } = createTestStore(catalog);
    const [first] = subqueries;
    store.savePage(first, 1, page([hit(303)]), complete(first.id), 'first');
    // A re-fetch may see a changed GitHub index; the committed page is the snapshot.
    store.savePage(first, 1, page([hit(999)]), complete(first.id), 'replay');

    expect(store.readCandidates().map((c) => c.id)).toEqual([303]);
    expect(store.readSubqueryCoverage(first.id).fetchedPages).toBe(1);
  });

  it('should roll back page data when checkpoint persistence fails', () => {
    const { store, subqueries } = createTestStore(catalog);
    const [first] = subqueries;

    expect(() =>
      store.savePage(
        first,
        1,
        page([hit(404)]),
        { subqueryId: first.id, nextPage: 0, state: 'pending' },
        't',
      ),
    ).toThrow();

    expect(store.readHits()).toHaveLength(0);
    expect(store.getCheckpoint(first.id)).toEqual({
      subqueryId: first.id,
      nextPage: 1,
      state: 'pending',
    });
  });

  it('should reject a page for a subquery that differs from the stored one', () => {
    const { store, subqueries } = createTestStore(catalog);
    const changed = { ...subqueries[0], q: 'changed' };

    expect(() =>
      store.savePage(changed, 1, page([hit(1)]), complete(changed.id), 't'),
    ).toThrow(/does not match/);
  });

  it('should aggregate coverage per subquery', () => {
    const { store, subqueries } = createTestStore(catalog);
    const [first] = subqueries;
    store.savePage(
      first,
      1,
      page([hit(1), hit(2)], { totalCount: 1500, hasNext: true }),
      { subqueryId: first.id, nextPage: 2, state: 'pending' },
      't',
    );
    store.markSubquery(
      { subqueryId: first.id, nextPage: null, state: 'partial' },
      'result cap reached',
    );

    expect(store.readSubqueryCoverage(first.id)).toEqual({
      subqueryId: first.id,
      queryId: 'repository-query',
      fetchedPages: 1,
      fetchedHits: 2,
      uniqueCandidates: 2,
      totalReported: 1500,
      incomplete: false,
      capped: true,
      state: 'partial',
      reason: 'result cap reached',
    });
    expect(store.readCoverage()).toHaveLength(4);
  });

  it('should queue only candidates without pushed_at and keep the queue idempotent', () => {
    const { store, subqueries } = createTestStore(catalog);
    const code = subqueries[3];
    store.savePage(
      code,
      1,
      page([
        hit(1, { path: 'package.json', metadata: { fork: false } }),
        hit(2, { path: 'package.json' }),
      ]),
      complete(code.id),
      't',
    );

    expect(store.queueEnrichment()).toBe(1);
    expect(store.queueEnrichment()).toBe(0);
    expect(store.readEnrichmentQueue()).toEqual([
      { repositoryId: 1, nodeId: 'R_1' },
    ]);
    expect(store.readEnrichmentCounts()).toEqual({
      pending: 1,
      ok: 0,
      not_found: 0,
      failed: 0,
    });
  });

  it('should store enrichment results and keep failures in the queue', () => {
    const { store, subqueries } = createTestStore(catalog);
    const code = subqueries[3];
    const noPush = { fork: false };
    store.savePage(
      code,
      1,
      page(
        [1, 2, 3].map((id) =>
          hit(id, { path: 'package.json', metadata: noPush }),
        ),
      ),
      complete(code.id),
      't',
    );
    store.queueEnrichment();

    store.saveEnrichments(
      [
        {
          repositoryId: 1,
          status: 'ok',
          data: { pushedAt: '2025-01-01T00:00:00Z' },
          reason: null,
        },
        { repositoryId: 2, status: 'not_found', data: null, reason: 'gone' },
        { repositoryId: 3, status: 'failed', data: null, reason: 'timeout' },
      ],
      'enriched-at',
    );

    expect(store.readEnrichmentQueue()).toEqual([
      { repositoryId: 3, nodeId: 'R_3' },
    ]);
    expect(store.readCandidates()[0].enrichment).toEqual({
      status: 'ok',
      fetchedAt: 'enriched-at',
      data: { pushedAt: '2025-01-01T00:00:00Z' },
      reason: null,
    });
    expect(store.readEnrichmentCounts()).toEqual({
      pending: 0,
      ok: 1,
      not_found: 1,
      failed: 1,
    });
  });

  it('should recover committed progress after reopening the database', () => {
    const { directory, store, subqueries } = createTestStore(catalog);
    const [first] = subqueries;
    store.savePage(
      first,
      1,
      page([hit(505)], { hasNext: true, totalCount: 2 }),
      { subqueryId: first.id, nextPage: 2, state: 'pending' },
      't',
    );
    store.close();

    const reopened = trackStore(openStore(join(directory, 'discovery.sqlite')));
    expect(reopened.getCheckpoint(first.id).nextPage).toBe(2);
    expect(reopened.readCandidates()).toHaveLength(1);
    expect(reopened.getSubqueries()).toEqual(subqueries);
  });

  it('should refuse a database from the previous schema', () => {
    const { directory } = createTestStore(catalog);
    const legacyPath = join(directory, 'legacy.sqlite');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec('CREATE TABLE runs (id TEXT PRIMARY KEY)');
    legacy.close();

    expect(() => openStore(legacyPath)).toThrow(
      /Unsupported discovery database schema/,
    );
    const check = new DatabaseSync(legacyPath);
    expect(
      check
        .prepare("SELECT name FROM sqlite_master WHERE name = 'subqueries'")
        .get(),
    ).toBeUndefined();
    check.close();
  });
});
