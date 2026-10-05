import { afterEach, describe, expect, it } from 'vitest';
import { runDiscovery } from '../src/discovery/runner.js';
import type {
  EnrichmentClient,
  EnrichmentTarget,
  SearchClient,
} from '../src/discovery/types.js';
import {
  catalogOf,
  cleanupTestStores,
  createTestStore,
  hit,
  page,
  query,
} from './helpers.js';

const first = query({ id: 'first' });
const second = query({ id: 'second' });
const oneQuery = catalogOf([first]);
const twoQueries = catalogOf([first, second]);
const fixedNow = () => 'now';
const noEnrichment: EnrichmentClient = {
  async fetchRepositories() {
    throw new Error('enrichment should not be called');
  },
};
const noPush = { fork: false };

afterEach(cleanupTestStores);

function run(
  store: ReturnType<typeof createTestStore>['store'],
  client: SearchClient,
  enrichmentClient: EnrichmentClient = noEnrichment,
  signal = new AbortController().signal,
) {
  return runDiscovery({
    store,
    client,
    enrichmentClient,
    signal,
    now: fixedNow,
  });
}

describe('runDiscovery', () => {
  it('should collect every candidate and finish complete', async () => {
    const { store } = createTestStore(oneQuery);
    const client: SearchClient = {
      async search() {
        return page(Array.from({ length: 20 }, (_, index) => hit(index + 1)));
      },
    };

    const result = await run(store, client);

    expect(store.readCandidates()).toHaveLength(20);
    expect(result.run.state).toBe('complete');
  });

  it('should search every subquery of a partitioned query with its effective q', async () => {
    const partitioned = catalogOf([
      query({
        id: 'p',
        q: 'x',
        partition: { by: 'created', from: '2026-09-01', interval: 'month' },
      }),
    ]);
    const { store } = createTestStore(partitioned);
    const searched: string[] = [];
    const client: SearchClient = {
      async search(subquery) {
        searched.push(subquery.q);
        return page([]);
      },
    };

    await run(store, client);

    expect(searched).toEqual([
      'x pushed:>=2024-01-01 created:<2026-09-01',
      'x pushed:>=2024-01-01 created:2026-09-01..2026-09-30',
      'x pushed:>=2024-01-01 created:>=2026-10-01',
    ]);
  });

  it('should resume from the first uncommitted page', async () => {
    const { store, subqueries } = createTestStore(oneQuery);
    store.savePage(
      subqueries[0],
      1,
      page([hit(1)], { hasNext: true, totalCount: 2 }),
      { subqueryId: 'first', nextPage: 2, state: 'pending' },
      'committed',
    );
    const requestedPages: number[] = [];
    const client: SearchClient = {
      async search(_subquery, pageNumber) {
        requestedPages.push(pageNumber);
        return page([hit(2)], { totalCount: 2 });
      },
    };

    await run(store, client);

    expect(requestedPages).toEqual([2]);
    expect(store.readCandidates().map(({ id }) => id)).toEqual([1, 2]);
  });

  it('should continue with later subqueries after one fails', async () => {
    const { store } = createTestStore(twoQueries);
    const requested: string[] = [];
    const client: SearchClient = {
      async search(subquery) {
        requested.push(subquery.id);
        if (subquery.id === 'first') throw new Error('temporary failure');
        return page([hit(2)]);
      },
    };

    const result = await run(store, client);

    expect(requested).toEqual(['first', 'second']);
    expect(store.getCheckpoint('first')).toMatchObject({
      nextPage: 1,
      state: 'failed',
    });
    expect(result.run.state).toBe('partial');
  });

  it('should mark capped and incomplete subqueries as partial', async () => {
    const { store } = createTestStore(twoQueries);
    const client: SearchClient = {
      async search(subquery) {
        return subquery.id === 'first'
          ? page([hit(1)], { totalCount: 1001 })
          : page([hit(2)], { incomplete: true });
      },
    };

    await run(store, client);

    expect(store.readSubqueryCoverage('first')).toMatchObject({
      capped: true,
      state: 'partial',
    });
    expect(store.readSubqueryCoverage('second')).toMatchObject({
      incomplete: true,
      state: 'partial',
    });
  });

  it('should stop after page ten and mark the subquery capped', async () => {
    const { store } = createTestStore(oneQuery);
    const requestedPages: number[] = [];
    const client: SearchClient = {
      async search(_subquery, pageNumber) {
        requestedPages.push(pageNumber);
        return page([hit(pageNumber)], { hasNext: true, totalCount: 1000 });
      },
    };

    await run(store, client);

    expect(requestedPages).toHaveLength(10);
    expect(store.readSubqueryCoverage('first')).toMatchObject({
      capped: true,
      state: 'partial',
    });
  });

  it('should enrich candidates without pushed_at in batches of one hundred', async () => {
    const { store } = createTestStore(oneQuery);
    const client: SearchClient = {
      async search() {
        return page([
          ...Array.from({ length: 150 }, (_, index) =>
            hit(index + 1, { metadata: noPush }),
          ),
          hit(999),
        ]);
      },
    };
    const batches: EnrichmentTarget[][] = [];
    const enrichmentClient: EnrichmentClient = {
      async fetchRepositories(targets) {
        batches.push(targets);
        return targets.map((target) => ({
          repositoryId: target.repositoryId,
          status: 'ok' as const,
          data: { pushedAt: '2025-01-01T00:00:00Z' },
          reason: null,
        }));
      },
    };

    const result = await run(store, client, enrichmentClient);

    expect(batches.map((batch) => batch.length)).toEqual([100, 50]);
    expect(batches.flat().some((target) => target.repositoryId === 999)).toBe(
      false,
    );
    expect(store.readEnrichmentCounts().ok).toBe(150);
    expect(result.run.state).toBe('complete');
  });

  it('should record a failed batch and finish partial', async () => {
    const { store } = createTestStore(oneQuery);
    const client: SearchClient = {
      async search() {
        return page([hit(1, { metadata: noPush })]);
      },
    };
    const enrichmentClient: EnrichmentClient = {
      async fetchRepositories() {
        throw new Error('GraphQL unavailable');
      },
    };

    const result = await run(store, client, enrichmentClient);

    expect(store.readCandidates()[0].enrichment).toMatchObject({
      status: 'failed',
      reason: 'GraphQL unavailable',
    });
    expect(result.run.state).toBe('partial');
  });

  it('should retry only failed enrichment on resume', async () => {
    const { store } = createTestStore(oneQuery);
    let searches = 0;
    const client: SearchClient = {
      async search() {
        searches += 1;
        return page([
          hit(1, { metadata: noPush }),
          hit(2, { metadata: noPush }),
        ]);
      },
    };
    const attempts: number[][] = [];
    const enrichmentClient: EnrichmentClient = {
      async fetchRepositories(targets) {
        attempts.push(targets.map((target) => target.repositoryId));
        return targets.map((target) =>
          attempts.length === 1 && target.repositoryId === 2
            ? {
                repositoryId: 2,
                status: 'failed' as const,
                data: null,
                reason: 'x',
              }
            : {
                repositoryId: target.repositoryId,
                status: 'ok' as const,
                data: { pushedAt: '2025-01-01T00:00:00Z' },
                reason: null,
              },
        );
      },
    };

    expect((await run(store, client, enrichmentClient)).run.state).toBe(
      'partial',
    );
    expect((await run(store, client, enrichmentClient)).run.state).toBe(
      'complete',
    );
    expect(searches).toBe(1);
    expect(attempts).toEqual([[1, 2], [2]]);
  });

  it('should stay partial when aborted before enrichment', async () => {
    const { store } = createTestStore(oneQuery);
    const controller = new AbortController();
    const client: SearchClient = {
      async search() {
        controller.abort(new Error('interrupted'));
        return page([hit(1, { metadata: noPush })]);
      },
    };

    const result = await run(store, client, noEnrichment, controller.signal);

    expect(store.getCheckpoint('first').state).toBe('complete');
    expect(store.readEnrichmentCounts().pending).toBe(1);
    expect(result.run.state).toBe('partial');
  });

  it('should preserve committed pages and leave later subqueries pending on abort', async () => {
    const { store } = createTestStore(twoQueries);
    const controller = new AbortController();
    const client: SearchClient = {
      async search(subquery, pageNumber) {
        if (subquery.id === 'first' && pageNumber === 1) {
          return page([hit(1)], { hasNext: true, totalCount: 2 });
        }
        controller.abort(new Error('interrupted'));
        throw new Error('interrupted');
      },
    };

    const result = await run(store, client, noEnrichment, controller.signal);

    expect(store.readCandidates().map(({ id }) => id)).toEqual([1]);
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
