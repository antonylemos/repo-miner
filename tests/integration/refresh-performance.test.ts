import {
  createSearchStore,
  hit,
  humanActivityRule,
  page,
  query,
} from '@tests/helpers.js';
import { expect, it } from 'vitest';
import { DEFAULT_COLLECTION_LIMITS } from '@/modules/discovery/collection/limits.js';
import { createCollectionScheduler } from '@/modules/discovery/collection/scheduler.js';

const CANDIDATES = 3_000;
/** Generous bound: the incremental pass takes milliseconds, the quadratic one minutes. */
const MAX_PASS_MS = 1_000;

function largeRound() {
  const { store, subqueries } = createSearchStore(
    [query({ id: 'q' })],
    '2026-10-05',
    [humanActivityRule()],
  );
  const subquery = subqueries[0];
  if (!subquery) throw new Error('Missing subquery');
  store.savePage(
    subquery,
    1,
    page(Array.from({ length: CANDIDATES }, (_, index) => hit(index + 1))),
    { subqueryId: subquery.id, nextPage: null, state: 'complete' },
    '2026-10-05T00:00:00.000Z',
  );
  const scheduler = createCollectionScheduler({
    store,
    metadataClient: {
      fetchRepositories: async () => {
        throw new Error('unexpected network use');
      },
    },
    makeActivityClient: () => {
      throw new Error('unexpected network use');
    },
    invocationId: 'test',
    limits: DEFAULT_COLLECTION_LIMITS,
    signal: new AbortController().signal,
    now: () => '2026-10-06T12:00:00.000Z',
  });
  return { store, scheduler };
}

it('should refresh an unchanged round in time independent of its task count', async () => {
  const { store, scheduler } = largeRound();
  await scheduler.refresh();
  expect(store.readTasks().length).toBeGreaterThanOrEqual(CANDIDATES);

  const startedAt = performance.now();
  await scheduler.refresh();
  const elapsed = performance.now() - startedAt;

  expect(elapsed).toBeLessThan(MAX_PASS_MS);
  store.close();
}, 600_000);
