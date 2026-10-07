import { createSearchStore, hit, page, query } from '@tests/helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_COLLECTION_LIMITS } from '@/modules/discovery/collection/limits.js';
import type { SearchClient } from '@/modules/discovery/model/search.js';
import type { DiscoveryStore } from '@/modules/discovery/model/store.js';
import { runDiscovery } from '@/modules/discovery/pipeline/run-discovery.js';

const first = query({ id: 'first' });
const second = query({ id: 'second' });
const stores: DiscoveryStore[] = [];
const fixedNow = () => 'now';
const complete = (subqueryId: string) => ({
  subqueryId,
  nextPage: null,
  state: 'complete' as const,
});

function open(queries = [first], expansionDate?: string) {
  const fixture = createSearchStore(queries, expansionDate);
  stores.push(fixture.store);
  return fixture;
}
function candidateIds(store: DiscoveryStore) {
  return [...store.iterateCandidates()].map(({ id }) => id);
}
function run(
  store: DiscoveryStore,
  client: SearchClient,
  signal = new AbortController().signal,
  onProgress?: (event: unknown) => void,
) {
  return runDiscovery({
    store,
    client,
    metadataClient: {
      async fetchRepositories() {
        throw new Error('metadata should not be collected without rules');
      },
    },
    makeActivityClient: () => {
      throw new Error('activity should not be collected without rules');
    },
    limits: DEFAULT_COLLECTION_LIMITS,
    signal,
    now: fixedNow,
    onProgress,
  });
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // A test may already have closed the store.
    }
  }
});

describe('search without a protocol', () => {
  it('should report search progress once per subquery', async () => {
    const { store } = open([first, second]);
    const events: unknown[] = [];

    await run(
      store,
      {
        async search() {
          return page([]);
        },
      },
      undefined,
      (event) => events.push(event),
    );

    expect(events).toEqual([
      { phase: 'search', done: 0, total: 2, label: '' },
      { phase: 'search', done: 1, total: 2, label: expect.any(String) },
      { phase: 'search', done: 2, total: 2, label: expect.any(String) },
    ]);
  });

  it('should search repositories and code endpoints concurrently', async () => {
    const { store } = open([
      query({ id: 'repo-a' }),
      query({ id: 'repo-b' }),
      query({ id: 'code-a', endpoint: 'code' }),
    ]);
    let releaseCode: () => void = () => {};
    const codeStarted = new Promise<void>((resolve) => {
      releaseCode = resolve;
    });
    const order: string[] = [];
    const events: { done: number }[] = [];
    const client: SearchClient = {
      async search(subquery) {
        order.push(subquery.id);
        if (subquery.endpoint === 'code') releaseCode();
        // A repositories search only resolves once the code lane has started.
        else await codeStarted;
        return page([]);
      },
    };

    const result = await run(store, client, undefined, (event) =>
      events.push(event as { done: number }),
    );

    expect(order.slice(0, 2).sort()).toEqual(['code-a', 'repo-a']);
    expect(order.filter((id) => id.startsWith('repo'))).toEqual([
      'repo-a',
      'repo-b',
    ]);
    expect(events.map(({ done }) => done)).toEqual([0, 1, 2, 3]);
    expect(result.run.state).toBe('complete');
  });

  it('should collect every candidate and finish complete', async () => {
    const { store } = open();
    const client: SearchClient = {
      async search() {
        return page(Array.from({ length: 20 }, (_, index) => hit(index + 1)));
      },
    };

    const result = await run(store, client);

    expect(candidateIds(store)).toHaveLength(20);
    expect(result.run.state).toBe('complete');
    expect(
      [...store.iterateCandidates()].every(
        (candidate) => candidate.evaluation?.status === 'not_applied',
      ),
    ).toBe(true);
  });

  it('should search every subquery of a partitioned query with its effective q', async () => {
    const { store } = open([
      query({
        id: 'p',
        q: 'x',
        partition: { by: 'created', from: '2026-09-01', interval: 'month' },
      }),
    ]);
    const searched: string[] = [];

    await run(store, {
      async search(subquery) {
        searched.push(subquery.q);
        return page([]);
      },
    });

    expect(searched).toEqual([
      'x created:<2026-09-01',
      'x created:2026-09-01..2026-09-30',
      'x created:>=2026-10-01',
    ]);
  });

  it('should resume from the first uncommitted page', async () => {
    const { store, subqueries } = open();
    store.savePage(
      subqueries[0],
      1,
      page([hit(1)], { hasNext: true, totalCount: 2 }),
      { subqueryId: 'first', nextPage: 2, state: 'pending' },
      'committed',
    );
    const requestedPages: number[] = [];

    await run(store, {
      async search(_subquery, pageNumber) {
        requestedPages.push(pageNumber);
        return page([hit(2)], { totalCount: 2 });
      },
    });

    expect(requestedPages).toEqual([2]);
    expect(candidateIds(store)).toEqual([1, 2]);
  });

  it('should continue with later subqueries after one fails', async () => {
    const { store } = open([first, second]);
    const requested: string[] = [];

    const result = await run(store, {
      async search(subquery) {
        requested.push(subquery.id);
        if (subquery.id === 'first') throw new Error('temporary failure');
        return page([hit(2)]);
      },
    });

    expect(requested).toEqual(['first', 'second']);
    expect(store.getCheckpoint('first')).toMatchObject({
      nextPage: 1,
      state: 'failed',
    });
    expect(result.run.state).toBe('partial');
  });

  it('should mark capped and incomplete subqueries as partial', async () => {
    const { store } = open([first, second]);

    const result = await run(store, {
      async search(subquery) {
        return subquery.id === 'first'
          ? page([hit(1)], { totalCount: 1001 })
          : page([hit(2)], { incomplete: true });
      },
    });

    expect(store.readSubqueryCoverage('first')).toMatchObject({
      capped: true,
      state: 'partial',
    });
    expect(store.readSubqueryCoverage('second')).toMatchObject({
      incomplete: true,
      state: 'partial',
    });
    expect(result.run.state).toBe('partial');
  });

  it('should stop after page ten and mark the subquery capped', async () => {
    const { store } = open();
    const requestedPages: number[] = [];

    await run(store, {
      async search(_subquery, pageNumber) {
        requestedPages.push(pageNumber);
        return page([hit(pageNumber)], { hasNext: true, totalCount: 1000 });
      },
    });

    expect(requestedPages).toHaveLength(10);
    expect(store.readSubqueryCoverage('first')).toMatchObject({
      capped: true,
      state: 'partial',
    });
  });

  it('should preserve committed pages and leave later subqueries pending on abort', async () => {
    const { store } = open([first, second]);
    const controller = new AbortController();

    const result = await run(
      store,
      {
        async search(subquery, pageNumber) {
          if (subquery.id === 'first' && pageNumber === 1) {
            return page([hit(1)], { hasNext: true, totalCount: 2 });
          }
          controller.abort(new Error('interrupted'));
          throw new Error('interrupted');
        },
      },
      controller.signal,
    );

    expect(candidateIds(store)).toEqual([1]);
    expect(store.getCheckpoint('first')).toMatchObject({
      nextPage: 2,
      state: 'failed',
    });
    expect(store.getCheckpoint('second')).toMatchObject({
      nextPage: 1,
      state: 'pending',
    });
    expect(result.run.state).toBe('partial');
  });
});

describe('search storage', () => {
  const catalog = [
    query({
      id: 'repository-query',
      q: 'microfrontend',
      partition: { by: 'created', from: '2026-09-01', interval: 'month' },
    }),
    query({
      id: 'code-query',
      strategy: 'technology',
      endpoint: 'code',
      q: 'single-spa filename:package.json',
    }),
  ];

  it('should persist subqueries in expansion order with their source query', () => {
    const { store, subqueries } = open(catalog);

    expect(store.getSubqueries()).toEqual(subqueries);
    expect(store.getSubqueries().map((s) => s.id)).toEqual([
      'repository-query#created:<2026-09-01',
      'repository-query#created:2026-09',
      'repository-query#created:>=2026-10-01',
      'code-query',
    ]);
    expect(store.getRun()).toMatchObject({ expansionDate: '2026-10-05' });
  });

  it('should keep one candidate with every subquery origin and fetch time', () => {
    const { store, subqueries } = open(catalog);
    const [firstSub, secondSub] = subqueries;
    const code = subqueries[3];
    store.savePage(firstSub, 1, page([hit(101)]), complete(firstSub.id), 't1');
    store.savePage(
      secondSub,
      1,
      page([hit(101)]),
      complete(secondSub.id),
      't2',
    );
    store.savePage(
      code,
      1,
      page([hit(101, { path: 'package.json' })]),
      complete(code.id),
      't3',
    );

    expect(candidateIds(store)).toEqual([101]);
    expect([...store.iterateCandidates()][0]).toMatchObject({
      id: 101,
      nodeId: 'R_101',
      firstSeenAt: 't1',
    });
    expect(
      store
        .readHits()
        .map((h) => [h.queryId, h.subqueryId, h.fetchedAt, h.qEffective]),
    ).toEqual([
      ['code-query', 'code-query', 't3', 'single-spa filename:package.json'],
      // Binary collation sorts "created:2026-09" before "created:<2026-09-01".
      ['repository-query', secondSub.id, 't2', secondSub.q],
      ['repository-query', firstSub.id, 't1', firstSub.q],
    ]);
  });

  it('should keep distinct normalized code paths for the same repository', () => {
    const { store, subqueries } = open(catalog);
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
    const { store, subqueries } = open(catalog);
    const [firstSub] = subqueries;
    store.savePage(firstSub, 1, page([hit(303)]), complete(firstSub.id), 'a');
    // A re-fetch may see a changed GitHub index; the committed page is the snapshot.
    store.savePage(firstSub, 1, page([hit(999)]), complete(firstSub.id), 'b');

    expect(candidateIds(store)).toEqual([303]);
    expect(store.readSubqueryCoverage(firstSub.id).fetchedPages).toBe(1);
  });

  it('should roll back page data when checkpoint persistence fails', () => {
    const { store, subqueries } = open(catalog);
    const [firstSub] = subqueries;

    expect(() =>
      store.savePage(
        firstSub,
        1,
        page([hit(404)]),
        { subqueryId: firstSub.id, nextPage: 0, state: 'pending' },
        't',
      ),
    ).toThrow();

    expect(store.readHits()).toHaveLength(0);
    expect(store.getCheckpoint(firstSub.id)).toEqual({
      subqueryId: firstSub.id,
      nextPage: 1,
      state: 'pending',
    });
  });

  it('should reject a page for a subquery that differs from the stored one', () => {
    const { store, subqueries } = open(catalog);
    const changed = { ...subqueries[0], q: 'changed' };

    expect(() =>
      store.savePage(changed, 1, page([hit(1)]), complete(changed.id), 't'),
    ).toThrow(/does not match/);
  });

  it('should aggregate coverage per subquery', () => {
    const { store, subqueries } = open(catalog);
    const [firstSub] = subqueries;
    store.savePage(
      firstSub,
      1,
      page([hit(1), hit(2)], { totalCount: 1500, hasNext: true }),
      { subqueryId: firstSub.id, nextPage: 2, state: 'pending' },
      't',
    );
    store.markSubquery(
      { subqueryId: firstSub.id, nextPage: null, state: 'partial' },
      'result cap reached',
    );

    expect(store.readSubqueryCoverage(firstSub.id)).toEqual({
      subqueryId: firstSub.id,
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
});
