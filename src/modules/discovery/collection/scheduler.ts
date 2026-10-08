import { evaluateProtocol } from '@/modules/discovery/eligibility/evaluate.js';
import type {
  ActivityClient,
  ActivityHooks,
  CollectionLimits,
  CollectionTask,
  CollectorStep,
} from '@/modules/discovery/model/collection.js';
import type { FactRequest } from '@/modules/discovery/model/facts.js';
import type { ProgressEvent } from '@/modules/discovery/model/progress.js';
import type { EnrichmentClient } from '@/modules/discovery/model/search.js';
import type { DiscoveryStore } from '@/modules/discovery/model/store.js';
import { collectActivityStep } from './activity-step.js';
import { BudgetExhaustedError } from './budget.js';

/** GraphQL metadata requests carry at most this many repositories. */
const METADATA_BATCH_SIZE = 100;
/** A refresh slice runs this long before yielding the event loop. */
const REFRESH_SLICE_MS = 25;
/** Smaller passes finish too fast to be worth a progress bar. */
const REFRESH_PROGRESS_MIN = 50;
/** Re-evaluations per candidate before it is left dirty for the next pass. */
const MAX_EVALUATION_ROUNDS = 5;

export type ActivityClientFactory = (
  task: CollectionTask,
  invocationId: string,
) => ActivityClient;
/** Bind these hooks when creating the HTTP activity client; retries each reserve an attempt. */
export function createActivityHooks(
  store: DiscoveryStore,
  task: CollectionTask,
  invocationId: string,
  limits: CollectionLimits,
): ActivityHooks {
  return {
    beforeAttempt: () =>
      store.reserveActivityAttempt(
        task.id,
        invocationId,
        limits.maxActivityRequestsPerCandidate,
      ),
    onAttemptFinished: (event) => store.saveAttempt(task.id, event),
  };
}
export type CollectionSchedulerOptions = {
  store: DiscoveryStore;
  metadataClient: EnrichmentClient;
  makeActivityClient: ActivityClientFactory;
  invocationId: string;
  limits: CollectionLimits;
  signal: AbortSignal;
  now: () => string;
  onProgress?: (event: ProgressEvent) => void;
};
export function createCollectionScheduler(options: CollectionSchedulerOptions) {
  const {
    store,
    metadataClient,
    makeActivityClient,
    invocationId,
    limits,
    signal,
    now,
  } = options;
  const reportProgress = (phase: 'metadata' | 'activity', label: string) => {
    const kind =
      phase === 'metadata' ? 'repository_metadata' : 'commit_history';
    let total = 0;
    let done = 0;
    for (const row of store.countTasks()) {
      if (row.kind !== kind || row.state === 'cancelled') continue;
      total += row.count;
      if (['complete', 'failed', 'limited'].includes(row.state))
        done += row.count;
    }
    options.onProgress?.({ phase, total, done, label });
  };
  const stopped = new Set<string>();
  const clients = new Map<string, ActivityClient>();
  let wake = () => {};
  let generation = 0;
  const emptyStep = (
    task: CollectionTask,
    state: CollectorStep['state'],
    reason: string | null,
  ): CollectorStep => ({
    repositoryObservations: [],
    commits: [],
    refs: [],
    response: null,
    checkpoint: task.checkpoint,
    state,
    reason,
  });
  /** Evaluates one candidate until its derived tasks stop changing, then stores the evaluation. */
  const evaluate = (
    candidate: { id: number; nodeId: string },
    protocol: ReturnType<DiscoveryStore['getStudyConfig']>['protocol'],
    completed: ReadonlyMap<number, FactRequest[]>,
  ) => {
    for (let round = 0; round < MAX_EVALUATION_ROUNDS; round++) {
      let facts = store.readCandidateFacts(candidate.id);
      if (protocol.eligibility.length && facts.inspectionUntil === null) {
        store.beginInspection(candidate.id, now());
        facts = store.readCandidateFacts(candidate.id);
      }
      const evaluation = evaluateProtocol(protocol, facts);
      const requests: FactRequest[] = [
        ...evaluation.requests,
        ...(completed.get(candidate.id) ?? []),
      ];
      // Identity-bound metadata is an acquisition dependency, independently of rule policy.
      if (requests.some((r) => r.kind === 'commit_history'))
        requests.push({
          kind: 'repository_metadata',
          repositoryId: candidate.id,
          nodeId: candidate.nodeId,
        });
      // Changed tasks change the facts, so the evaluation must be recomputed.
      if (store.syncTasks(candidate.id, requests)) continue;
      store.saveEvaluation(candidate.id, evaluation, facts.revision);
      return;
    }
  };
  let running: Promise<void> | null = null;
  /** Re-evaluates only candidates whose facts changed, yielding the event loop between slices. */
  const pass = async () => {
    const protocol = store.getStudyConfig().protocol;
    const dirty = store.readDirtyCandidates();
    if (!dirty.length) return;
    const completed = store.readCompletedRequests();
    const report = (done: number) => {
      if (dirty.length >= REFRESH_PROGRESS_MIN)
        options.onProgress?.({
          phase: 'refresh',
          done,
          total: dirty.length,
          label: 'candidatos',
        });
    };
    report(0);
    let sliceStartedAt = performance.now();
    for (const [index, candidate] of dirty.entries()) {
      evaluate(candidate, protocol, completed);
      if (index + 1 === dirty.length) report(dirty.length);
      if (performance.now() - sliceStartedAt < REFRESH_SLICE_MS) continue;
      report(index + 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      // Abort is honoured between slices, so a pass always records at least one slice of work.
      if (signal.aborted) return;
      sliceStartedAt = performance.now();
    }
  };
  const refresh = (): Promise<void> => {
    running ??= pass().finally(() => {
      running = null;
    });
    return running;
  };
  const metadata = async (tasks: CollectionTask[]) => {
    for (const t of tasks) stopped.add(t.id);
    let results: Awaited<ReturnType<EnrichmentClient['fetchRepositories']>>;
    try {
      results = await metadataClient.fetchRepositories(
        tasks.map((t) => ({
          repositoryId: t.repositoryId,
          nodeId:
            t.request.kind === 'repository_metadata' ? t.request.nodeId : '',
        })),
        signal,
      );
    } catch (error) {
      if (signal.aborted) return;
      results = tasks.map((t) => ({
        repositoryId: t.repositoryId,
        status: 'failed' as const,
        data: null,
        reason: error instanceof Error ? error.message : String(error),
      }));
    }
    if (signal.aborted) return;
    const observedAt = now();
    for (const task of tasks) {
      const result = results.find((r) => r.repositoryId === task.repositoryId);
      const status = result?.status ?? 'failed';
      const data = result?.data ?? {};
      const validIdentity =
        status === 'ok' &&
        typeof data.nameWithOwner === 'string' &&
        data.nameWithOwner.split('/').length === 2;
      store.saveCollectionStep(task, {
        ...emptyStep(
          task,
          validIdentity ? 'complete' : 'failed',
          result?.reason ??
            (validIdentity ? null : 'repository_identity_unavailable'),
        ),
        repositoryObservations: [
          {
            id: `metadata:${task.id}:${invocationId}`,
            repositoryId: task.repositoryId,
            source: 'enrichment',
            observedAt,
            data,
            status,
          },
        ],
      });
    }
    await refresh();
  };
  const activity = async (task: CollectionTask) => {
    const facts = store.readCandidateFacts(task.repositoryId);
    if (
      !facts.observations.some(
        (o) =>
          o.source === 'enrichment' &&
          o.status === 'ok' &&
          typeof o.data.nameWithOwner === 'string',
      )
    ) {
      stopped.add(task.id);
      return;
    }
    const remaining =
      limits.maxActivityDurationMs === null
        ? null
        : Math.max(
            0,
            limits.maxActivityDurationMs -
              store.readActiveDuration(task.repositoryId, invocationId),
          );
    if (remaining === 0) {
      store.saveCollectionStep(
        task,
        emptyStep(task, 'limited', 'duration_budget'),
      );
      stopped.add(task.id);
      await refresh();
      return;
    }
    const child = new AbortController();
    const abort = () => child.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer =
      remaining === null
        ? null
        : setTimeout(
            () => child.abort(new BudgetExhaustedError('duration_budget')),
            remaining,
          );
    const startedAt = Date.parse(now());
    try {
      let client = clients.get(task.id);
      if (!client) {
        client = makeActivityClient(task, invocationId);
        clients.set(task.id, client);
      }
      const result = await collectActivityStep(
        task,
        facts,
        client,
        child.signal,
      );
      if (signal.aborted) return;
      if (child.signal.aborted)
        store.saveCollectionStep(
          task,
          emptyStep(task, 'limited', 'duration_budget'),
        );
      else store.saveCollectionStep(task, result);
      if (result.state !== 'pending' || child.signal.aborted)
        stopped.add(task.id);
    } finally {
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      store.recordCollectionDuration(
        task.id,
        invocationId,
        Math.max(0, Date.parse(now()) - startedAt),
      );
    }
    await refresh();
  };
  const work = async () => {
    await refresh();
    if (signal.aborted) return false;
    const batch = store.readOpenTasks(
      'repository_metadata',
      METADATA_BATCH_SIZE,
      stopped,
    );
    if (batch.length) {
      reportProgress('metadata', `lote de ${batch.length} repositórios`);
      await metadata(batch);
      reportProgress('metadata', `lote de ${batch.length} repositórios`);
      return true;
    }
    const [task] = store.readOpenTasks('commit_history', 1, stopped);
    if (task) {
      reportProgress('activity', `repositório ${task.repositoryId}`);
      await activity(task);
      reportProgress('activity', `repositório ${task.repositoryId}`);
      return true;
    }
    return false;
  };
  return {
    refresh,
    wake: () => {
      generation++;
      wake();
    },
    async whileSearching(search: Promise<unknown>): Promise<void> {
      let searching = true;
      const settled = search.then(
        () => {
          searching = false;
        },
        () => {
          searching = false;
        },
      );
      while (searching && !signal.aborted) {
        const beforeWork = generation;
        if ((await work()) || generation !== beforeWork) continue;
        if (signal.aborted) return;
        let onAbort = () => {};
        try {
          await Promise.race([
            new Promise<void>((resolve) => {
              wake = resolve;
            }),
            settled,
            new Promise<void>((resolve) => {
              onAbort = resolve;
              signal.addEventListener('abort', onAbort, { once: true });
            }),
          ]);
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      }
    },
    async drain(): Promise<void> {
      await refresh();
      while (!signal.aborted && (await work())) {
        /* Persist and evaluate after each provider step. */
      }
    },
  };
}
