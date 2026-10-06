import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnrichmentClient } from '../src/discovery/enrichment.js';
import { exportRun } from '../src/discovery/report.js';
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
  it('should retry only a node affected by a partial GraphQL response', async () => {
    const { store } = createTestStore(oneQuery);
    let searches = 0;
    const client: SearchClient = {
      async search() {
        searches++;
        return page([hit(1, { metadata: {} }), hit(2, { metadata: {} })]);
      },
    };
    const attempts: string[][] = [];
    const enrichmentClient = createEnrichmentClient({
      token: 'secret',
      now: () => 0,
      sleep: async () => {},
      fetchFn: async (_input, init) => {
        attempts.push(JSON.parse(String(init?.body)).variables.ids);
        return new Response(
          JSON.stringify(
            attempts.length === 1
              ? {
                  data: {
                    nodes: [
                      { databaseId: 1, pushedAt: null },
                      { databaseId: 2, pushedAt: '2025-01-01T00:00:00Z' },
                    ],
                  },
                  errors: [
                    {
                      path: ['nodes', 0, 'pushedAt'],
                      message: 'temporarily unavailable',
                    },
                  ],
                }
              : {
                  data: {
                    nodes: [
                      { databaseId: 1, pushedAt: '2025-01-01T00:00:00Z' },
                    ],
                  },
                },
          ),
        );
      },
    });
    expect((await run(store, client, enrichmentClient)).run.state).toBe(
      'partial',
    );
    expect(store.readEnrichmentSummary().required).toEqual({
      pending: 0,
      failed: 1,
    });
    expect((await run(store, client, enrichmentClient)).run.state).toBe(
      'complete',
    );
    expect(searches).toBe(1);
    expect(attempts).toEqual([['R_1', 'R_2'], ['R_1']]);
    expect(store.readEnrichmentCounts()).toEqual({
      pending: 0,
      ok: 2,
      not_found: 0,
      failed: 0,
    });
  });

  it('should retain an in-flight failure when REST subsequently makes enrichment unnecessary', async () => {
    const { store } = createTestStore(
      catalogOf([
        query({ id: 'repo' }),
        query({ id: 'code', endpoint: 'code' }),
      ]),
    );
    let releaseRest: () => void = () => {};
    const graphqlStarted = new Promise<void>((resolve) => {
      releaseRest = resolve;
    });
    let releaseGraphql: () => void = () => {};
    const restCommitted = new Promise<void>((resolve) => {
      releaseGraphql = resolve;
    });
    let calls = 0;
    const result = await runDiscovery({
      store,
      signal: new AbortController().signal,
      now: fixedNow,
      client: {
        async search(subquery) {
          if (subquery.endpoint === 'repositories') await graphqlStarted;
          return page(
            Array.from({ length: 100 }, (_, index) =>
              hit(index + 1, {
                metadata:
                  subquery.endpoint === 'code'
                    ? {}
                    : { pushed_at: '2025-01-01T00:00:00Z' },
              }),
            ),
          );
        },
      },
      enrichmentClient: {
        async fetchRepositories(targets) {
          calls++;
          releaseRest();
          await restCommitted;
          return targets.map((target) => ({
            repositoryId: target.repositoryId,
            status: 'failed' as const,
            data: null,
            reason: 'GraphQL unavailable',
          }));
        },
      },
      onProgress(event) {
        if (event.phase === 'search' && event.done === 2) releaseGraphql();
      },
    });
    expect(calls).toBe(1);
    expect(result.run.state).toBe('complete');
    expect(store.readEnrichmentSummary()).toEqual({
      counts: { pending: 0, ok: 0, not_found: 0, failed: 100 },
      required: { pending: 0, failed: 0 },
      superseded: { pending: 0, failed: 100 },
    });
    expect(store.readCandidates()[0].enrichment?.reason).toBe(
      'GraphQL unavailable',
    );
  });

  it.each(['pending', 'failed'] as const)(
    'should complete with a superseded %s enrichment without extra requests',
    async (status) => {
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
        { subqueryId: 'code', nextPage: null, state: 'complete' },
        'code-at',
      );
      store.queueEnrichment();
      if (status === 'failed')
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
      store.savePage(
        subqueries[0],
        1,
        page([hit(1)]),
        { subqueryId: 'repo', nextPage: null, state: 'complete' },
        'rest-at',
      );
      let searches = 0;
      let enrichments = 0;
      const result = await run(
        store,
        {
          async search() {
            searches++;
            return page([]);
          },
        },
        {
          async fetchRepositories() {
            enrichments++;
            return [];
          },
        },
      );
      expect(result.run.state).toBe('complete');
      expect(searches).toBe(0);
      expect(enrichments).toBe(0);
      expect(store.readCandidates()[0].enrichment?.status).toBe(status);
    },
  );

  it('should produce the same CSV and scope after either confirmed endpoint order when enrichment is dispensable', async () => {
    const csv: string[] = [];
    for (const codeFirst of [true, false]) {
      const { directory, store, subqueries } = createTestStore(
        catalogOf([
          query({ id: 'repo' }),
          query({ id: 'historical-code', endpoint: 'code' }),
          query({ id: 'code', endpoint: 'code' }),
        ]),
      );
      // Both permutations begin with the same retained enrichment history.
      store.savePage(
        subqueries[1],
        1,
        page([hit(1, { metadata: {} })]),
        { subqueryId: 'historical-code', nextPage: null, state: 'complete' },
        '2026-10-06T09:00:00Z',
      );
      store.queueEnrichment();
      let release: () => void = () => {};
      const committed = new Promise<void>((resolve) => {
        release = resolve;
      });
      let searches = 0;
      let enrichments = 0;
      const result = await runDiscovery({
        store,
        client: {
          async search(subquery) {
            searches++;
            if ((subquery.endpoint === 'code') !== codeFirst) await committed;
            return page([
              hit(1, {
                metadata:
                  subquery.endpoint === 'code'
                    ? {}
                    : { pushed_at: '2025-01-01T00:00:00Z' },
              }),
            ]);
          },
        },
        enrichmentClient: {
          async fetchRepositories() {
            enrichments++;
            return [];
          },
        },
        signal: new AbortController().signal,
        now: () => '2026-10-06T10:00:00Z',
        onProgress(event) {
          const firstId = codeFirst ? 'code' : 'repo';
          const secondId = codeFirst ? 'repo' : 'code';
          if (event.phase === 'search' && event.label === firstId) {
            expect(store.getCheckpoint(firstId)).toEqual({
              subqueryId: firstId,
              nextPage: null,
              state: 'complete',
            });
            expect(store.getCheckpoint(secondId).state).toBe('pending');
            expect(
              store.readHits().find((hit) => hit.subqueryId === firstId)
                ?.endpoint,
            ).toBe(codeFirst ? 'code' : 'repositories');
            release();
          }
        },
      });
      expect(result.run.state).toBe('complete');
      expect(searches).toBe(2);
      expect(enrichments).toBe(0);
      await exportRun(store, directory);
      csv.push(readFileSync(join(directory, 'candidates.csv'), 'utf8'));
      const coverage = JSON.parse(
        readFileSync(join(directory, 'coverage.json'), 'utf8'),
      );
      expect(coverage.byScope).toEqual({
        in_scope: 1,
        out_of_scope_temporal: 0,
        unknown: 0,
      });
    }
    expect(csv[0]).toBe(csv[1]);
  });

  it('should report search progress once per subquery', async () => {
    const { store } = createTestStore(twoQueries);
    const client: SearchClient = {
      async search() {
        return page([]);
      },
    };
    const events: unknown[] = [];

    await runDiscovery({
      store,
      client,
      enrichmentClient: noEnrichment,
      signal: new AbortController().signal,
      now: fixedNow,
      onProgress: (event) => events.push(event),
    });

    expect(events).toEqual([
      { phase: 'search', done: 0, total: 2, label: '' },
      { phase: 'search', done: 1, total: 2, label: expect.any(String) },
      { phase: 'search', done: 2, total: 2, label: expect.any(String) },
    ]);
  });

  it('should search repositories and code endpoints concurrently', async () => {
    const { store } = createTestStore(
      catalogOf([
        query({ id: 'repo-a' }),
        query({ id: 'repo-b' }),
        query({ id: 'code-a', endpoint: 'code' }),
      ]),
    );
    let releaseCode: () => void = () => {};
    const codeStarted = new Promise<void>((resolve) => {
      releaseCode = resolve;
    });
    const order: string[] = [];
    const client: SearchClient = {
      async search(subquery) {
        order.push(subquery.id);
        if (subquery.endpoint === 'code') releaseCode();
        // A repositories search only resolves once the code lane has started.
        else await codeStarted;
        return page([]);
      },
    };
    const events: { done: number }[] = [];

    const result = await runDiscovery({
      store,
      client,
      enrichmentClient: noEnrichment,
      signal: new AbortController().signal,
      now: fixedNow,
      onProgress: (event) => events.push(event),
    });

    expect(order.slice(0, 2).sort()).toEqual(['code-a', 'repo-a']);
    expect(order.filter((id) => id.startsWith('repo'))).toEqual([
      'repo-a',
      'repo-b',
    ]);
    expect(events.map(({ done }) => done)).toEqual([0, 1, 2, 3]);
    expect(result.run.state).toBe('complete');
  });

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

  it('should enrich full batches while search is still running', async () => {
    const { store } = createTestStore(twoQueries);
    let releaseSecond: () => void = () => {};
    const enrichmentStarted = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const client: SearchClient = {
      async search(subquery) {
        if (subquery.id === 'first') {
          return page(
            Array.from({ length: 120 }, (_, index) =>
              hit(index + 1, { metadata: noPush }),
            ),
          );
        }
        // The second search only resolves once enrichment has begun.
        await enrichmentStarted;
        return page([hit(500, { metadata: noPush })]);
      },
    };
    const batches: number[] = [];
    const enrichmentClient: EnrichmentClient = {
      async fetchRepositories(targets) {
        batches.push(targets.length);
        releaseSecond();
        return targets.map((target) => ({
          repositoryId: target.repositoryId,
          status: 'ok' as const,
          data: { pushedAt: '2025-01-01T00:00:00Z' },
          reason: null,
        }));
      },
    };
    const events: unknown[] = [];

    const result = await runDiscovery({
      store,
      client,
      enrichmentClient,
      signal: new AbortController().signal,
      now: fixedNow,
      onProgress: (event) => events.push(event),
    });

    expect(batches).toEqual([100, 21]);
    expect(store.readEnrichmentCounts().ok).toBe(121);
    expect(result.run.state).toBe('complete');
    // Enrichment progress only covers the work left once search finishes.
    expect(
      events.filter(
        (event) => (event as { phase: string }).phase === 'enrichment',
      ),
    ).toEqual([
      { phase: 'enrichment', done: 0, total: 21, label: '' },
      { phase: 'enrichment', done: 21, total: 21, label: '21 repositórios' },
    ]);
  });

  it('should not retry a batch that failed earlier in the same run', async () => {
    const { store } = createTestStore(twoQueries);
    const client: SearchClient = {
      async search(subquery) {
        return subquery.id === 'first'
          ? page(
              Array.from({ length: 100 }, (_, index) =>
                hit(index + 1, { metadata: noPush }),
              ),
            )
          : page([]);
      },
    };
    let calls = 0;
    const enrichmentClient: EnrichmentClient = {
      async fetchRepositories() {
        calls += 1;
        throw new Error('GraphQL unavailable');
      },
    };

    const result = await run(store, client, enrichmentClient);

    expect(calls).toBe(1);
    expect(store.readEnrichmentCounts().failed).toBe(100);
    expect(result.run.state).toBe('partial');
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
