import { catalogHash } from './catalog.js';
import type { DiscoveryStore } from './storage.js';
import type { Catalog, RunResult, SearchClient } from './types.js';

export type RunDiscoveryOptions = {
  catalog: Catalog;
  store: DiscoveryStore;
  client: SearchClient;
  signal: AbortSignal;
  now: () => string;
};

/** Runs catalog queries sequentially; GitHub's search index may change during a run. */
export async function runDiscovery(
  options: RunDiscoveryOptions,
): Promise<RunResult> {
  const { catalog, store, client, signal, now } = options;
  const run = store.getRun();
  if (
    catalogHash(catalog) !== run.catalogHash ||
    catalogHash(store.getCatalog()) !== run.catalogHash
  ) {
    throw new Error('Catalog does not match the catalog stored for this run');
  }

  for (const query of catalog.queries) {
    if (signal.aborted) break;
    let checkpoint = store.getCheckpoint(query.id);
    if (checkpoint.state === 'complete' || checkpoint.state === 'partial')
      continue;
    const oldCoverage = store
      .readCoverage()
      .find((entry) => entry.queryId === query.id);
    let pageNumber = checkpoint.nextPage ?? 1;
    let incomplete = oldCoverage?.incomplete ?? false;
    let capped =
      (oldCoverage?.capped ?? false) ||
      (oldCoverage?.totalReported ?? 0) > 1000;

    while (pageNumber <= 10 && !signal.aborted) {
      try {
        const page = await client.search(query, pageNumber, signal);
        incomplete ||= page.incomplete;
        capped ||=
          page.totalCount > 1000 || (pageNumber === 10 && page.hasNext);
        const exhausted = !page.hasNext || pageNumber === 10;
        const isPartial = exhausted && (incomplete || capped);
        checkpoint = {
          queryId: query.id,
          nextPage: exhausted ? null : pageNumber + 1,
          state: exhausted ? (isPartial ? 'partial' : 'complete') : 'pending',
        };
        store.savePage(query, pageNumber, page, checkpoint, now());
        if (isPartial) {
          const reasons = [
            incomplete ? 'incomplete GitHub search results' : '',
            capped ? 'result cap reached' : '',
          ].filter(Boolean);
          store.markQuery(checkpoint, reasons.join('; '));
        }
        if (exhausted) break;
        pageNumber += 1;
      } catch (error) {
        checkpoint = {
          queryId: query.id,
          nextPage: pageNumber,
          state: 'failed',
        };
        store.markQuery(
          checkpoint,
          error instanceof Error ? error.message : String(error),
        );
        break;
      }
    }
    if (signal.aborted) break;
  }

  const coverage = store.readCoverage();
  const result: RunResult = {
    run: {
      ...store.getRun(),
      endedAt: now(),
      state: coverage.every((entry) => entry.state === 'complete')
        ? 'complete'
        : 'partial',
    },
    coverage,
  };
  store.finish(result);
  return result;
}
