import { canonicalJson } from './catalog.js';
import {
  type ActivityClientFactory,
  createCollectionScheduler,
} from './collection.js';
import type { CollectionLimits } from './collectors/types.js';
import { runSearch } from './search.js';
import type { DiscoveryStore, Run } from './storage/store.js';
import type { Coverage, EnrichmentClient, SearchClient } from './types.js';
export type ProgressEvent = {
  phase: 'search' | 'metadata' | 'activity';
  done: number;
  total: number;
  label: string;
};
export type DiscoveryOptions = {
  store: DiscoveryStore;
  client: SearchClient;
  metadataClient: EnrichmentClient;
  makeActivityClient: ActivityClientFactory;
  limits: CollectionLimits;
  signal: AbortSignal;
  now: () => string;
  onProgress?: (event: ProgressEvent) => void;
};
// A run has one owner in this process. Cross-process execution needs an external lease.
const activeRuns = new Set<string>();
export async function runDiscovery(
  options: DiscoveryOptions,
): Promise<{ run: Run; coverage: Coverage[] }> {
  const { store, client, signal, now, onProgress } = options;
  const run = store.getRun();
  if (activeRuns.has(run.id))
    throw new Error('Protocol run already has an active invocation');
  activeRuns.add(run.id);
  try {
    const summary = store.readCollectionSummary();
    const initialInvocation = run.invocations[0];
    const fresh =
      initialInvocation !== undefined &&
      run.state === 'running' &&
      run.endedAt === null &&
      run.invocations.length === 1 &&
      canonicalJson(initialInvocation.limits) ===
        canonicalJson(options.limits) &&
      summary.activity.attempts === 0 &&
      summary.metadata.attempts === 0 &&
      store.readCoverage().every((c) => c.fetchedPages === 0) &&
      store.readTasks().length === 0;
    const invocationId = fresh
      ? initialInvocation.id
      : store.startInvocation(options.limits, now());
    const scheduler = createCollectionScheduler({ ...options, invocationId });
    const search = runSearch({
      store,
      client,
      signal,
      now,
      onPage: () => scheduler.wake(),
      onProgress: (done, total, label) =>
        onProgress?.({ phase: 'search', done, total, label }),
    });
    await Promise.all([search, scheduler.whileSearching(search)]);
    await scheduler.drain();
    const coverage = store.readCoverage();
    const required = store.readCollectionSummary().required;
    const complete =
      coverage.every((c) => c.state === 'complete') &&
      required.pending === 0 &&
      required.failed === 0 &&
      required.limited === 0 &&
      required.pendingEvaluations === 0;
    store.finish({ state: complete ? 'complete' : 'partial', endedAt: now() });
    return { run: store.getRun(), coverage };
  } finally {
    activeRuns.delete(run.id);
  }
}
