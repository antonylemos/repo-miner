import { catalogHash } from './catalog.js';
import { ENRICHMENT_BATCH_SIZE } from './enrichment.js';
import { runSearch } from './search.js';
import type { DiscoveryStore } from './storage.js';
import type {
  EnrichmentClient,
  EnrichmentTarget,
  RunResult,
  SearchClient,
} from './types.js';

export type RunDiscoveryOptions = {
  store: DiscoveryStore;
  client: SearchClient;
  enrichmentClient: EnrichmentClient;
  signal: AbortSignal;
  now: () => string;
  onProgress?: (event: ProgressEvent) => void;
};

/**
 * Reports a phase starting (`done` 0) or one subquery/enrichment batch finishing.
 * Enrichment progress only covers the batches left once search finishes; full
 * batches enriched during search are not reported.
 */
export type ProgressEvent = {
  phase: 'search' | 'enrichment';
  done: number;
  total: number;
  label: string;
};

/** Runs each endpoint's subqueries sequentially, endpoints and enrichment concurrently; GitHub's index may change during a run. */
export async function runDiscovery(
  options: RunDiscoveryOptions,
): Promise<RunResult> {
  const { store, client, enrichmentClient, signal, now, onProgress } = options;
  const run = store.getRun();
  if (catalogHash(store.getCatalog()) !== run.catalogHash) {
    throw new Error('Catalog does not match the catalog stored for this run');
  }

  const enricher = createEnricher(store, enrichmentClient, signal, now);
  const search = runSearch({
    store,
    client,
    signal,
    now,
    onPage: () => enricher.wake(),
    onProgress: (done, total, label) =>
      onProgress?.({ phase: 'search', done, total, label }),
  });
  // GraphQL has its own rate limit, so full batches are enriched while search runs.
  await Promise.all([search, enricher.whileSearching(search)]);
  // Queue even after an abort so the run cannot be reported complete with unenriched candidates.
  store.queueEnrichment();
  if (!signal.aborted) await enricher.drain(onProgress);

  const coverage = store.readCoverage();
  const enrichment = store.readEnrichmentSummary();
  const complete =
    coverage.every((entry) => entry.state === 'complete') &&
    enrichment.required.pending === 0 &&
    enrichment.required.failed === 0;
  const result: RunResult = {
    run: {
      ...store.getRun(),
      endedAt: now(),
      state: complete ? 'complete' : 'partial',
    },
    coverage,
  };
  store.finish(result);
  return result;
}

/** Enriches queued candidates, attempting each one at most once per run so failures wait for a resume. */
function createEnricher(
  store: DiscoveryStore,
  client: EnrichmentClient,
  signal: AbortSignal,
  now: () => string,
) {
  const attempted = new Set<number>();
  let wake = () => {};

  const unattempted = () => {
    store.queueEnrichment();
    return store
      .readEnrichmentQueue()
      .filter((target) => !attempted.has(target.repositoryId));
  };

  const enrichBatch = async (batch: EnrichmentTarget[]) => {
    for (const target of batch) attempted.add(target.repositoryId);
    try {
      store.saveEnrichments(
        await client.fetchRepositories(batch, signal),
        now(),
      );
    } catch (error) {
      if (signal.aborted) return;
      const reason = error instanceof Error ? error.message : String(error);
      store.saveEnrichments(
        batch.map((target) => ({
          repositoryId: target.repositoryId,
          status: 'failed' as const,
          data: null,
          reason,
        })),
        now(),
      );
    }
  };

  return {
    /** Signals that search may have stored new candidates. */
    wake: () => wake(),

    /** Sends only full batches until search settles; the caller handles search errors. */
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
        const queue = unattempted();
        if (queue.length >= ENRICHMENT_BATCH_SIZE) {
          await enrichBatch(queue.slice(0, ENRICHMENT_BATCH_SIZE));
          continue;
        }
        // No await separates reading the queue from arming the wake-up, so no signal is lost.
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          settled,
        ]);
      }
    },

    /** Sends every remaining batch, including a final partial one. */
    async drain(onProgress?: (event: ProgressEvent) => void): Promise<void> {
      const queue = unattempted();
      if (queue.length === 0) return;
      onProgress?.({
        phase: 'enrichment',
        done: 0,
        total: queue.length,
        label: '',
      });
      for (
        let start = 0;
        start < queue.length && !signal.aborted;
        start += ENRICHMENT_BATCH_SIZE
      ) {
        const batch = queue.slice(start, start + ENRICHMENT_BATCH_SIZE);
        await enrichBatch(batch);
        if (signal.aborted) return;
        onProgress?.({
          phase: 'enrichment',
          done: Math.min(start + ENRICHMENT_BATCH_SIZE, queue.length),
          total: queue.length,
          label: `${batch.length} repositórios`,
        });
      }
    },
  };
}
