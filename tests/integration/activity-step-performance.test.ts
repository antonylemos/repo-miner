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
import type { ActivityClient } from '@/modules/discovery/model/collection.js';

const CANDIDATES = 2_000;
const STEPS = 5;
/** Generous bound: a step does milliseconds of local work, the full-round summary took far longer. */
const MAX_MEDIAN_STEP_MS = 150;

const now = () => '2026-10-06T12:00:00.000Z';
const observedPage = () => ({
  items: [],
  hasNext: false,
  observedAt: now(),
  requestUrl: 'offline',
  raw: [],
});
const instantClient: ActivityClient = {
  readBranch: async (_target, name) => ({
    ref: { name, headSha: 'a'.repeat(40), observedAt: now() },
    observedAt: now(),
    requestUrl: 'offline',
    raw: {},
  }),
  listBranches: async () => observedPage(),
  listCommits: async () => observedPage(),
};

it('should keep the activity step cost independent of the work already collected', async () => {
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
  const scheduler = (
    invocationId: string,
    signal: AbortSignal,
    onStep?: () => void,
  ) =>
    createCollectionScheduler({
      store,
      metadataClient: {
        fetchRepositories: async (targets) =>
          targets.map((target) => ({
            repositoryId: target.repositoryId,
            status: 'ok' as const,
            data: { nameWithOwner: `org/repo-${target.repositoryId}` },
            reason: null,
          })),
      },
      makeActivityClient: () => instantClient,
      invocationId,
      limits: DEFAULT_COLLECTION_LIMITS,
      signal,
      now,
      onProgress: (event) => {
        if (event.phase === 'activity') onStep?.();
      },
    });

  // Resolve every metadata task, stopping before the first activity request.
  const earlier = store.startInvocation(DEFAULT_COLLECTION_LIMITS, now());
  const setup = new AbortController();
  await scheduler(earlier, setup.signal, () => setup.abort()).drain();
  expect(
    store.readOpenTasks('commit_history', CANDIDATES, new Set()).length,
  ).toBe(CANDIDATES);

  // Past work: thousands of attempt and duration groups across two invocations.
  const invocationId = store.startInvocation(DEFAULT_COLLECTION_LIMITS, now());
  const event = {
    attempt: 1,
    startedAt: 100,
    finishedAt: 110,
    waitMs: 0,
    status: 200,
    responseBytes: 5,
    rateLimitResource: 'core',
    rateLimitUsed: 1,
    error: null,
  };
  for (const task of store.readOpenTasks(
    'commit_history',
    CANDIDATES,
    new Set(),
  )) {
    for (const id of [earlier, invocationId]) {
      store.reserveActivityAttempt(task.id, id, 20);
      store.saveAttempt(task.id, event);
      store.recordCollectionDuration(task.id, id, 10);
    }
  }

  const controller = new AbortController();
  const times: number[] = [];
  let events = 0;
  let last = performance.now();
  await scheduler(invocationId, controller.signal, () => {
    // Each step reports twice: before and after the work.
    events += 1;
    if (events % 2 === 0) times.push(performance.now() - last);
    last = performance.now();
    if (events >= STEPS * 2) controller.abort();
  }).drain();

  times.sort((a, b) => a - b);
  expect(times.length).toBeGreaterThanOrEqual(STEPS - 1);
  expect(times[Math.floor(times.length / 2)]).toBeLessThan(MAX_MEDIAN_STEP_MS);
  store.close();
}, 600_000);
