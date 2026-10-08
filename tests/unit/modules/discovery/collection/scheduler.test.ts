import {
  commitFact,
  createSearchStore,
  hit,
  humanActivityRule,
  page,
  query,
} from '@tests/helpers.js';
import { expect, it } from 'vitest';
import { DEFAULT_COLLECTION_LIMITS } from '@/modules/discovery/collection/limits.js';
import { createCollectionScheduler } from '@/modules/discovery/collection/scheduler.js';
import { evaluateProtocol } from '@/modules/discovery/eligibility/evaluate.js';
import type {
  CollectionTask,
  CollectorStep,
} from '@/modules/discovery/model/collection.js';
import type { FactRequest } from '@/modules/discovery/model/facts.js';
import type { ProgressEvent } from '@/modules/discovery/model/progress.js';
import type { DiscoveryStore } from '@/modules/discovery/model/store.js';

const now = () => '2026-10-06T12:00:00.000Z';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture');
  return value;
}

function roundOf(count: number) {
  const { store, subqueries } = createSearchStore(
    [query({ id: 'q' })],
    '2026-10-05',
    [humanActivityRule()],
  );
  const subquery = required(subqueries[0]);
  store.savePage(
    subquery,
    1,
    page(Array.from({ length: count }, (_, index) => hit(index + 1))),
    { subqueryId: subquery.id, nextPage: null, state: 'complete' },
    '2026-10-05T00:00:00.000Z',
  );
  return { store, subquery };
}

function schedulerFor(
  store: DiscoveryStore,
  signal?: AbortSignal,
  onProgress?: (event: ProgressEvent) => void,
) {
  return createCollectionScheduler({
    onProgress,
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
    signal: signal ?? new AbortController().signal,
    now,
  });
}

/** Counts evaluations stored through `store`, calling `onSave` with the running total. */
function countEvaluations(store: DiscoveryStore, onSave?: (n: number) => void) {
  const save = store.saveEvaluation.bind(store);
  let saved = 0;
  store.saveEvaluation = (...args) => {
    save(...args);
    saved++;
    onSave?.(saved);
  };
  return () => saved;
}

it('stops between slices when aborted, leaving the rest dirty for the next pass', async () => {
  const total = 1_500;
  const { store } = roundOf(total);
  const controller = new AbortController();
  const saved = countEvaluations(store, (n) => {
    if (n === 100) controller.abort();
  });

  await schedulerFor(store, controller.signal).refresh();

  const remaining = store.readDirtyCandidates().length;
  expect(remaining).toBeGreaterThan(0);
  expect(saved()).toBe(total - remaining);
  for (const candidate of store.iterateCandidates())
    if (candidate.evaluation !== null)
      expect(candidate.evaluationRevision).toBe(candidate.factsRevision);

  const resumed = countEvaluations(store);
  await schedulerFor(store).refresh();
  expect(resumed()).toBe(remaining);
  expect(store.readDirtyCandidates()).toEqual([]);
  store.close();
}, 120_000);

it('shares one pass between concurrent refresh calls', async () => {
  const { store } = roundOf(20);
  const saved = countEvaluations(store);
  const scheduler = schedulerFor(store);

  await Promise.all([scheduler.refresh(), scheduler.refresh()]);

  expect(saved()).toBe(20);
  store.close();
});

it('does not rewrite evaluations or tasks when no evidence changed', async () => {
  const { store } = roundOf(30);
  const scheduler = schedulerFor(store);
  await scheduler.refresh();
  const tasks = JSON.stringify(store.readTasks());
  const saved = countEvaluations(store);

  await scheduler.refresh();

  expect(saved()).toBe(0);
  expect(JSON.stringify(store.readTasks())).toBe(tasks);
  store.close();
});

/** The pre-incremental algorithm: every candidate, every task, until nothing changes. */
function fullRefresh(store: DiscoveryStore) {
  const protocol = store.getStudyConfig().protocol;
  const snapshot = () =>
    JSON.stringify([
      store.readTasks(),
      [...store.iterateCandidates()].map((c) => c.evaluation),
    ]);
  let before: string;
  do {
    before = snapshot();
    for (const candidate of store.iterateCandidates()) {
      let facts = store.readCandidateFacts(candidate.id);
      if (facts.inspectionUntil === null) {
        store.beginInspection(candidate.id, now());
        facts = store.readCandidateFacts(candidate.id);
      }
      const evaluation = evaluateProtocol(protocol, facts);
      const requests: FactRequest[] = [
        ...evaluation.requests,
        ...store
          .readTasks()
          .filter(
            (t) => t.repositoryId === candidate.id && t.state === 'complete',
          )
          .map((t) => t.request),
      ];
      if (requests.some((r) => r.kind === 'commit_history'))
        requests.push({
          kind: 'repository_metadata',
          repositoryId: candidate.id,
          nodeId: candidate.nodeId,
        });
      store.syncTasks(candidate.id, requests);
      store.saveEvaluation(
        candidate.id,
        evaluation,
        store.readCandidateFacts(candidate.id).revision,
      );
    }
  } while (snapshot() !== before);
}

const step = (
  task: CollectionTask,
  overrides: Partial<CollectorStep>,
): CollectorStep => ({
  repositoryObservations: [],
  commits: [],
  refs: [],
  response: null,
  checkpoint: task.checkpoint,
  state: 'complete',
  reason: null,
  ...overrides,
});

/** Moves candidates into varied states: complete, failed, limited, qualifying and cancelled. */
function advance(store: DiscoveryStore) {
  const humanCommit = (repositoryId: number) =>
    commitFact({ repositoryId, sha: String(repositoryId).padStart(40, '0') });
  for (const task of store.readTasks()) {
    if (task.state === 'cancelled') continue;
    const variant = task.repositoryId % 6;
    if (task.request.kind === 'repository_metadata') {
      if (variant === 1)
        store.saveCollectionStep(
          task,
          step(task, {
            repositoryObservations: [
              {
                id: `metadata:${task.id}`,
                repositoryId: task.repositoryId,
                source: 'enrichment',
                observedAt: now(),
                status: 'ok',
                data: { nameWithOwner: `org/repo-${task.repositoryId}` },
              },
            ],
          }),
        );
      continue;
    }
    if (variant === 1) store.saveCollectionStep(task, step(task, {}));
    else if (variant === 2)
      store.saveCollectionStep(
        task,
        step(task, { commits: [humanCommit(task.repositoryId)] }),
      );
    else if (variant === 3)
      store.saveCollectionStep(
        task,
        step(task, { state: 'failed', reason: 'http_500' }),
      );
    else if (variant === 4)
      store.saveCollectionStep(
        task,
        step(task, { state: 'limited', reason: 'duration_budget' }),
      );
    else if (variant === 5)
      store.saveCollectionStep(
        task,
        step(task, {
          state: 'pending',
          checkpoint: { page: 2 } as unknown as CollectionTask['checkpoint'],
          commits: [humanCommit(task.repositoryId)],
        }),
      );
  }
}

function outcome(store: DiscoveryStore) {
  return {
    tasks: store.readTasks(),
    evaluations: [...store.iterateCandidates()].map((c) => [
      c.id,
      c.evaluation,
    ]),
  };
}

it('stores the same tasks and evaluations as a full refresh', async () => {
  const incremental = roundOf(60).store;
  const reference = roundOf(60).store;
  const scheduler = schedulerFor(incremental);

  await scheduler.refresh();
  fullRefresh(reference);
  expect(outcome(incremental)).toEqual(outcome(reference));

  advance(incremental);
  advance(reference);
  await scheduler.refresh();
  fullRefresh(reference);

  const states = new Set(incremental.readTasks().map((t) => t.state));
  expect(states).toEqual(
    new Set(['pending', 'complete', 'failed', 'limited', 'cancelled']),
  );
  expect(outcome(incremental)).toEqual(outcome(reference));
  expect(incremental.readDirtyCandidates()).toEqual([]);
  incremental.close();
  reference.close();
});

it('reports evaluation progress for a large pass, ending at the total', async () => {
  const { store } = roundOf(120);
  const events: ProgressEvent[] = [];

  await schedulerFor(store, undefined, (e) => events.push(e)).refresh();

  expect(events.length).toBeGreaterThanOrEqual(2);
  expect(events.every((e) => e.phase === 'refresh' && e.total === 120)).toBe(
    true,
  );
  expect(events[0]?.done).toBe(0);
  expect(events.at(-1)?.done).toBe(120);
  expect(events.map((e) => e.done)).toEqual(
    [...events.map((e) => e.done)].sort((a, b) => a - b),
  );
  store.close();
});

it('stays silent for a small pass', async () => {
  const { store } = roundOf(10);
  const events: ProgressEvent[] = [];

  await schedulerFor(store, undefined, (e) => events.push(e)).refresh();

  expect(events).toEqual([]);
  store.close();
});
