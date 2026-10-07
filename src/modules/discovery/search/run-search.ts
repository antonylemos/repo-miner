import type {
  Checkpoint,
  SearchClient,
  Subquery,
} from '@/modules/discovery/model/search.js';
import type { SearchStore } from '@/modules/discovery/model/store.js';

const MAX_PAGES = 10;
const RESULT_CAP = 1000;
export type SearchOptions = {
  store: SearchStore;
  client: SearchClient;
  signal: AbortSignal;
  now: () => string;
  onPage?: () => void;
  onProgress?: (done: number, total: number, id: string) => void;
};
/** Endpoints have independent pacing; subqueries on each endpoint remain sequential. */
export async function runSearch(options: SearchOptions): Promise<void> {
  const { store, client, signal, now, onPage, onProgress } = options;
  const subqueries = store.getSubqueries();
  let done = 0;
  onProgress?.(0, subqueries.length, '');
  await Promise.all(
    [...new Set(subqueries.map((s) => s.endpoint))].map(async (endpoint) => {
      for (const subquery of subqueries.filter(
        (s) => s.endpoint === endpoint,
      )) {
        if (signal.aborted) return;
        await searchSubquery(store, client, subquery, signal, now, onPage);
        onProgress?.(++done, subqueries.length, subquery.id);
      }
    }),
  );
}

async function searchSubquery(
  store: SearchStore,
  client: SearchClient,
  subquery: Subquery,
  signal: AbortSignal,
  now: () => string,
  onPage?: () => void,
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
      onPage?.();
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
