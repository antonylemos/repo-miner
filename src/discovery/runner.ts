import { catalogHash } from './catalog.js';
import { ENRICHMENT_BATCH_SIZE } from './enrichment.js';
import type { DiscoveryStore } from './storage.js';
import type {
  Checkpoint,
  EnrichmentClient,
  EnrichmentTarget,
  RunResult,
  SearchClient,
  Subquery,
} from './types.js';

const MAX_PAGES = 10;
const RESULT_CAP = 1000;

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

  const subqueries = store.getSubqueries();
  const enricher = createEnricher(store, enrichmentClient, signal, now);
  onProgress?.({
    phase: 'search',
    done: 0,
    total: subqueries.length,
    label: '',
  });
  // Each endpoint has its own GitHub rate limit, so endpoints run concurrently
  // while subqueries within one endpoint stay sequential to respect its pacing.
  let done = 0;
  const searchEndpoint = async (endpointSubqueries: Subquery[]) => {
    for (const subquery of endpointSubqueries) {
      if (signal.aborted) return;
      await searchSubquery(store, client, subquery, signal, now);
      done += 1;
      enricher.wake();
      onProgress?.({
        phase: 'search',
        done,
        total: subqueries.length,
        label: subquery.id,
      });
    }
  };
  const endpoints = [...new Set(subqueries.map(({ endpoint }) => endpoint))];
  const search = Promise.all(
    endpoints.map((endpoint) =>
      searchEndpoint(subqueries.filter((s) => s.endpoint === endpoint)),
    ),
  );
  // GraphQL has its own rate limit, so full batches are enriched while search runs.
  await Promise.all([search, enricher.whileSearching(search)]);
  // Queue even after an abort so the run cannot be reported complete with unenriched candidates.
  store.queueEnrichment();
  if (!signal.aborted) await enricher.drain(onProgress);

  const coverage = store.readCoverage();
  const enrichment = store.readEnrichmentCounts();
  const complete =
    coverage.every((entry) => entry.state === 'complete') &&
    enrichment.pending === 0 &&
    enrichment.failed === 0;
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

async function searchSubquery(
  store: DiscoveryStore,
  client: SearchClient,
  subquery: Subquery,
  signal: AbortSignal,
  now: () => string,
): Promise<void> {
  let checkpoint = store.getCheckpoint(subquery.id);
  if (checkpoint.state === 'complete' || checkpoint.state === 'partial') return;
  const previous = store.readSubqueryCoverage(subquery.id);
  let pageNumber = checkpoint.nextPage ?? 1;
  let incomplete = previous.incomplete;
  let capped = previous.capped || previous.totalReported > RESULT_CAP;

  while (pageNumber <= MAX_PAGES && !signal.aborted) {
    try {
      const page = await client.search(subquery, pageNumber, signal);
      incomplete ||= page.incomplete;
      capped ||=
        page.totalCount > RESULT_CAP ||
        (pageNumber === MAX_PAGES && page.hasNext);
      const exhausted = !page.hasNext || pageNumber === MAX_PAGES;
      const isPartial = exhausted && (incomplete || capped);
      checkpoint = {
        subqueryId: subquery.id,
        nextPage: exhausted ? null : pageNumber + 1,
        state: exhausted ? (isPartial ? 'partial' : 'complete') : 'pending',
      } satisfies Checkpoint;
      store.savePage(subquery, pageNumber, page, checkpoint, now());
      if (isPartial) {
        const reasons = [
          incomplete ? 'incomplete GitHub search results' : '',
          capped ? 'result cap reached' : '',
        ].filter(Boolean);
        store.markSubquery(checkpoint, reasons.join('; '));
      }
      if (exhausted) return;
      pageNumber += 1;
    } catch (error) {
      store.markSubquery(
        { subqueryId: subquery.id, nextPage: pageNumber, state: 'failed' },
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
  }
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
