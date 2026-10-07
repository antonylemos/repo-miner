import { readFileSync } from 'node:fs';
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
  it('should keep reads coherent across a writer commit and see it in the next snapshot', async () => {
    const { directory, store, subqueries } = createTestStore(
      catalogOf([query({ id: 'repo' })]),
    );
    const writer = trackStore(openStore(join(directory, 'discovery.sqlite')));
    const subquery = subqueries[0];
    expect(
      await store.withReadSnapshot(async (snapshot) => {
        expect(snapshot.readCandidates()).toHaveLength(0);
        await Promise.resolve();
        writer.savePage(
          subquery,
          1,
          page([hit(1)]),
          complete(subquery.id),
          'at',
        );
        expect(snapshot.readCandidates()).toHaveLength(0);
        expect(snapshot.getCheckpoint(subquery.id).state).toBe('pending');
        return 'snapshot-result';
      }),
    ).toBe('snapshot-result');
    expect(
      await store.withReadSnapshot(
        async (snapshot) => snapshot.readCandidates().length,
      ),
    ).toBe(1);
  });

  it('should reject nested snapshots and roll back after callback failure', async () => {
    const { store, subqueries } = createTestStore(
      catalogOf([query({ id: 'repo' })]),
    );
    await expect(
      store.withReadSnapshot(async (snapshot) => {
        snapshot.getRun();
        await snapshot.withReadSnapshot(async (nested) => nested.getRun());
      }),
    ).rejects.toThrow(/nested|already active/i);
    await expect(
      store.withReadSnapshot(async (snapshot) => {
        snapshot.getRun();
        throw new Error('cancelled work');
      }),
    ).rejects.toThrow('cancelled work');
    store.savePage(subqueries[0], 1, page([hit(1)]), complete('repo'), 'at');
    expect(
      await store.withReadSnapshot(
        async (snapshot) => snapshot.readCandidates().length,
      ),
    ).toBe(1);
  });

  it.each([false, true])(
    'should release a snapshot when candidate iteration is cancelled (failure=%s)',
    async (failure) => {
      const { directory, store, subqueries } = createTestStore(
        catalogOf([query({ id: 'repo' })]),
      );
      const writer = trackStore(openStore(join(directory, 'discovery.sqlite')));
      writer.savePage(
        subqueries[0],
        1,
        page([hit(1), hit(2)]),
        { subqueryId: 'repo', nextPage: 2, state: 'pending' },
        'at',
      );
      const work = store.withReadSnapshot(async (snapshot) => {
        for (const candidate of snapshot.iterateCandidates()) {
          expect(candidate.id).toBe(1);
          if (failure) throw new Error('iterator cancelled');
          break;
        }
      });
      if (failure) await expect(work).rejects.toThrow('iterator cancelled');
      else await work;
      writer.savePage(
        subqueries[0],
        2,
        page([hit(3)]),
        complete('repo'),
        'later',
      );
      // A leaked iterator would retain its older view even after the transaction ends.
      expect(
        await store.withReadSnapshot(
          async (snapshot) => snapshot.readCandidates().length,
        ),
      ).toBe(3);
      store.savePage(
        subqueries[0],
        3,
        page([hit(4)]),
        complete('repo'),
        'last',
      );
      expect(store.readCandidates()).toHaveLength(4);
    },
  );

  it('should support snapshots in an in-memory database', async () => {
    const store = trackStore(openStore(':memory:'));
    store.createRun({
      catalog,
      hash: catalogHash(catalog),
      startedAt: 'at',
      expansionDate: '2026-10-05',
      subqueries: [],
    });
    expect(
      await store.withReadSnapshot(async (snapshot) => snapshot.getCatalog()),
    ).toEqual(catalog);
  });

  it.each(['failed', 'pending'] as const)(
    'should preserve a %s enrichment but stop retrying it after a usable REST observation',
    (status) => {
      const { store, subqueries } = createTestStore(
        catalogOf([
          query({ id: 'repo' }),
          query({ id: 'code', endpoint: 'code' }),
        ]),
      );
      store.savePage(
        subqueries[1],
        1,
        page([hit(1, { metadata: {} })]),
        complete('code'),
        'code-at',
      );
      store.queueEnrichment();
      if (status === 'failed') {
        store.saveEnrichments(
          [
            {
              repositoryId: 1,
              status,
              data: null,
              reason: 'GraphQL unavailable',
            },
          ],
          'failed-at',
        );
      }
      store.savePage(
        subqueries[0],
        1,
        page([hit(1)]),
        complete('repo'),
        'rest-at',
      );

      expect(store.readEnrichmentQueue()).toEqual([]);
      expect(store.queueEnrichment()).toBe(0);
      expect(store.readEnrichmentSummary()).toEqual({
        counts: {
          pending: status === 'pending' ? 1 : 0,
          ok: 0,
          not_found: 0,
          failed: status === 'failed' ? 1 : 0,
        },
        required: { pending: 0, failed: 0 },
        superseded: {
          pending: status === 'pending' ? 1 : 0,
          failed: status === 'failed' ? 1 : 0,
        },
      });
      expect(store.readCandidates()[0].enrichment).toMatchObject({
        status,
        reason: status === 'failed' ? 'GraphQL unavailable' : null,
      });
    },
  );

  it('should queue invalid search pushes and count failures still required', () => {
    const { store, subqueries } = createTestStore(
      catalogOf([query({ id: 'repo' })]),
    );
    store.savePage(
      subqueries[0],
      1,
      page([
        hit(1, { metadata: { pushed_at: 'invalid' } }),
        hit(2, { metadata: { pushed_at: '' } }),
        hit(3, { metadata: { pushed_at: 123 } }),
        hit(4),
      ]),
      complete('repo'),
      'at',
    );
    expect(store.queueEnrichment()).toBe(3);
    store.saveEnrichments(
      [
        {
          repositoryId: 1,
          status: 'failed',
          data: null,
          reason: 'unavailable',
        },
      ],
      'at',
    );
    expect(store.readEnrichmentSummary()).toEqual({
      counts: { pending: 2, ok: 0, not_found: 0, failed: 1 },
      required: { pending: 2, failed: 1 },
      superseded: { pending: 0, failed: 0 },
    });
    expect(
      store.readEnrichmentQueue().map((target) => target.repositoryId),
    ).toEqual([1, 2, 3]);
  });

  it('should select repository metadata regardless of endpoint arrival order', () => {
    for (const codeFirst of [true, false]) {
      const { store, subqueries } = createTestStore(
        catalogOf(
          [query({ id: 'repo' }), query({ id: 'code', endpoint: 'code' })],
          '2025-04-01',
        ),
      );
      const metadata = {
        pushed_at: '2026-10-01T00:00:00Z',
        description: 'shell',
        topics: ['example'],
        license: { spdx_id: 'MIT' },
      };
      const observations = [
        {
          subquery: subqueries[1],
          result: hit(1, { path: 'package.json', metadata: {} }),
          at: '2026-10-06T10:00:00Z',
        },
        {
          subquery: subqueries[0],
          result: hit(1, { metadata }),
          at: '2026-10-06T10:01:00Z',
        },
      ];
      observations[1].result.candidate.fullName = 'org/renamed';
      observations[1].result.candidate.url = 'https://github.com/org/renamed';
      observations[1].result.candidate.nodeId = 'later-node';
      if (!codeFirst) observations.reverse();
      for (const { subquery, result, at } of observations) {
        store.savePage(subquery, 1, page([result]), complete(subquery.id), at);
      }
      const candidate = store.readCandidates()[0];
      expect(candidate.metadata).toEqual(metadata);
      expect(candidate).toHaveProperty(
        'metadataObservedAt',
        '2026-10-06T10:01:00Z',
      );
      expect(candidate.firstSeenAt).toBe(
        codeFirst ? '2026-10-06T10:00:00Z' : '2026-10-06T10:01:00Z',
      );
      expect(candidate.fullName).toBe('org/renamed');
      expect(candidate.url).toBe('https://github.com/org/renamed');
      expect(candidate.nodeId).toBe(codeFirst ? 'R_1' : 'later-node');
      expect([...store.iterateCandidates()]).toEqual(store.readCandidates());
      expect(store.readCandidates()).toHaveLength(1);
      expect(store.readHits()).toHaveLength(2);
    }
  });

  it('should choose one deterministic REST observation', () => {
    const { store, subqueries } = createTestStore(
      catalogOf(['z', 'b', 'a', 'valid-late'].map((id) => query({ id }))),
    );
    const valid = '2026-10-01T00:00:00Z';
    const save = (
      index: number,
      entries: ReturnType<typeof hit>[],
      at: string,
    ) => {
      const subquery = subqueries[index];
      store.savePage(subquery, 1, page(entries), complete(subquery.id), at);
    };
    save(
      0,
      [
        hit(1, { metadata: { description: 'missing' } }),
        hit(2, { metadata: { pushed_at: valid, description: 'later' } }),
        hit(3, { metadata: { pushed_at: valid, description: 'z' } }),
      ],
      '2026-10-06T10:02:00Z',
    );
    save(
      1,
      [
        hit(1, { metadata: { pushed_at: 'invalid', topics: ['invalid'] } }),
        hit(2, { metadata: { pushed_at: valid, description: 'earlier' } }),
        hit(3, { metadata: { pushed_at: valid, description: 'b' } }),
      ],
      '2026-10-06T10:01:00Z',
    );
    save(
      2,
      [
        hit(3, {
          path: 'z',
          metadata: { pushed_at: valid, description: 'path-z' },
        }),
        hit(3, {
          path: 'a',
          metadata: { pushed_at: valid, description: 'path-a' },
        }),
      ],
      '2026-10-06T10:01:00Z',
    );
    save(
      3,
      [hit(1, { metadata: { pushed_at: valid, description: 'valid' } })],
      '2026-10-06T10:03:00Z',
    );
    expect(
      store.readCandidates().map((candidate) => candidate.metadata),
    ).toEqual([
      { pushed_at: valid, description: 'valid' },
      { pushed_at: valid, description: 'earlier' },
      { pushed_at: valid, description: 'path-a' },
    ]);
  });

  it('should use the earliest REST observation when none has a usable push', () => {
    const { store, subqueries } = createTestStore(
      catalogOf([query({ id: 'later' }), query({ id: 'earlier' })]),
    );
    for (const [id, value] of [
      null,
      '',
      'invalid',
      123,
      { date: '2026-10-01' },
    ].entries()) {
      store.savePage(
        subqueries[0],
        id + 1,
        page([
          hit(id + 1, { metadata: { pushed_at: value, description: 'later' } }),
        ]),
        complete(subqueries[0].id),
        '2026-10-06T10:01:00Z',
      );
      store.savePage(
        subqueries[1],
        id + 1,
        page([hit(id + 1, { metadata: { description: 'earlier' } })]),
        complete(subqueries[1].id),
        '2026-10-06T10:00:00Z',
      );
    }
    expect(
      store
        .readCandidates()
        .map((candidate) => [candidate.metadata, candidate.metadataObservedAt]),
    ).toEqual(
      Array.from({ length: 5 }, () => [
        { description: 'earlier' },
        '2026-10-06T10:00:00Z',
      ]),
    );
  });

  it('should preserve candidate metadata and provenance without a REST observation', () => {
    const { store, subqueries } = createTestStore(
      catalogOf([query({ id: 'code', endpoint: 'code' })]),
    );
    store.savePage(
      subqueries[0],
      1,
      page([
        hit(1, { path: 'package.json', metadata: { description: 'original' } }),
      ]),
      complete('code'),
      '2026-10-06T10:00:00Z',
    );
    expect(store.readCandidates()[0]).toMatchObject({
      metadata: { description: 'original' },
      metadataObservedAt: '2026-10-06T10:00:00Z',
      firstSeenAt: '2026-10-06T10:00:00Z',
    });
  });

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
    expect(check.prepare('PRAGMA journal_mode').get()).toEqual({
      journal_mode: 'delete',
    });
    check.close();
  });
});

it.each([77, 2, 3])(
  'refuses an existing tableless version %i without modifying its bytes',
  (version) => {
    const { directory } = createTestStore(catalog);
    const path = join(directory, `tableless-${version}.sqlite`);
    const database = new DatabaseSync(path);
    database.exec(`PRAGMA user_version=${version}`);
    database.close();
    const before = readFileSync(path);
    expect(() => openStore(path)).toThrow(
      /Unsupported discovery database schema/,
    );
    expect(readFileSync(path)).toEqual(before);
    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(
      version,
    );
    check.close();
  },
);
