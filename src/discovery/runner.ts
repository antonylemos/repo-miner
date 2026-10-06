import { catalogHash } from './catalog.js';
import { ENRICHMENT_BATCH_SIZE } from './enrichment.js';
import type { DiscoveryStore } from './storage.js';
import type {
  Checkpoint,
  EnrichmentClient,
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

/** Reports a phase starting (`done` 0) or one subquery/enrichment batch finishing. */
export type ProgressEvent = {
  phase: 'search' | 'enrichment';
  done: number;
  total: number;
  label: string;
};

/** Runs stored subqueries sequentially, then enriches candidates; GitHub's index may change during a run. */
export async function runDiscovery(
  options: RunDiscoveryOptions,
): Promise<RunResult> {
  const { store, client, enrichmentClient, signal, now, onProgress } = options;
  const run = store.getRun();
  if (catalogHash(store.getCatalog()) !== run.catalogHash) {
    throw new Error('Catalog does not match the catalog stored for this run');
  }

  const subqueries = store.getSubqueries();
  onProgress?.({
    phase: 'search',
    done: 0,
    total: subqueries.length,
    label: '',
  });
  for (const [index, subquery] of subqueries.entries()) {
    if (signal.aborted) break;
    await searchSubquery(store, client, subquery, signal, now);
    onProgress?.({
      phase: 'search',
      done: index + 1,
      total: subqueries.length,
      label: subquery.id,
    });
  }
  // Queue even after an abort so the run cannot be reported complete with unenriched candidates.
  store.queueEnrichment();
  if (!signal.aborted) {
    await enrichCandidates(store, enrichmentClient, signal, now, onProgress);
  }

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

async function enrichCandidates(
  store: DiscoveryStore,
  client: EnrichmentClient,
  signal: AbortSignal,
  now: () => string,
  onProgress?: (event: ProgressEvent) => void,
): Promise<void> {
  const queue = store.readEnrichmentQueue();
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
    onProgress?.({
      phase: 'enrichment',
      done: Math.min(start + ENRICHMENT_BATCH_SIZE, queue.length),
      total: queue.length,
      label: `${batch.length} repositórios`,
    });
  }
}
