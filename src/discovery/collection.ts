import { collectActivityStep } from './collectors/activity.js';
import {
  type ActivityClient,
  type ActivityHooks,
  BudgetExhaustedError,
  type CollectionLimits,
  type CollectionTask,
  type CollectorStep,
} from './collectors/types.js';
import { evaluateProtocol } from './eligibility/evaluate.js';
import type { FactRequest } from './eligibility/types.js';
import type { ProgressEvent } from './runner.js';
import type { DiscoveryStore } from './storage/store.js';
import type { EnrichmentClient } from './types.js';

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
    const tasks = store
      .readTasks()
      .filter(
        (task) => task.request.kind === kind && task.state !== 'cancelled',
      );
    options.onProgress?.({
      phase,
      total: tasks.length,
      done: tasks.filter((task) =>
        ['complete', 'failed', 'limited'].includes(task.state),
      ).length,
      label,
    });
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
  const refresh = () => {
    const protocol = store.getStudyConfig().protocol;
    for (const candidate of store.iterateCandidates()) {
      let facts = store.readCandidateFacts(candidate.id);
      if (protocol.eligibility.length && facts.inspectionUntil === null) {
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
      // Identity-bound metadata is an acquisition dependency, independently of rule policy.
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
  };
  const pending = () =>
    store
      .readTasks()
      .filter(
        (t) =>
          !stopped.has(t.id) && !['complete', 'cancelled'].includes(t.state),
      );
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
    refresh();
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
    const elapsed =
      store
        .readCollectionSummary()
        .perCandidate.find(
          (c) =>
            c.repositoryId === task.repositoryId &&
            c.invocationId === invocationId,
        )?.activity.activeDurationMs ?? 0;
    const remaining =
      limits.maxActivityDurationMs === null
        ? null
        : Math.max(0, limits.maxActivityDurationMs - elapsed);
    if (remaining === 0) {
      store.saveCollectionStep(
        task,
        emptyStep(task, 'limited', 'duration_budget'),
      );
      stopped.add(task.id);
      refresh();
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
    refresh();
  };
  const work = async () => {
    refresh();
    const tasks = pending();
    const batch = tasks
      .filter((t) => t.request.kind === 'repository_metadata')
      .slice(0, 100);
    if (batch.length) {
      reportProgress('metadata', `lote de ${batch.length} repositórios`);
      await metadata(batch);
      reportProgress('metadata', `lote de ${batch.length} repositórios`);
      return true;
    }
    const task = tasks.find((t) => t.request.kind === 'commit_history');
    if (task) {
      reportProgress('activity', `repositório ${task.repositoryId}`);
      await activity(task);
      reportProgress('activity', `repositório ${task.repositoryId}`);
      return true;
    }
    return false;
  };
  return {
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
      refresh();
      while (!signal.aborted && (await work())) {
        /* Persist and evaluate after each provider step. */
      }
    },
  };
}
