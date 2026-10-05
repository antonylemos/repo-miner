import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogHash } from '../src/discovery/catalog.js';
import { runDiscovery } from '../src/discovery/runner.js';
import { openStore } from '../src/discovery/storage.js';
import type {
  Catalog,
  Query,
  SearchClient,
  SearchPage,
} from '../src/discovery/types.js';

const dirs: string[] = [];
const stores: ReturnType<typeof openStore>[] = [];
const firstQuery: Query = {
  id: 'first',
  strategy: 'terminology',
  endpoint: 'repositories',
  q: 'first',
};
const oneQueryCatalog: Catalog = { version: 1, queries: [firstQuery] };

function createStore(catalog: Catalog) {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-runner-'));
  dirs.push(dir);
  const store = openStore(join(dir, 'discovery.sqlite'));
  stores.push(store);
  store.createRun(catalog, catalogHash(catalog), 'started');
  return store;
}

function searchPage(
  ids: number[],
  hasNext = false,
  totalCount = ids.length,
  incomplete = false,
): SearchPage {
  return {
    totalCount,
    incomplete,
    hasNext,
    hits: ids.map((id) => ({
      candidate: {
        id,
        fullName: `org/${id}`,
        url: `https://github.com/org/${id}`,
        metadata: {},
      },
      path: null,
      url: `https://github.com/org/${id}`,
    })),
  };
}

const fixedNow = () => 'finished';

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runDiscovery', () => {
  it('should collect all candidates even when there are more than fifteen', async () => {
    const store = createStore(oneQueryCatalog);
    const client: SearchClient = {
      async search() {
        return searchPage(Array.from({ length: 20 }, (_, index) => index + 1));
      },
    };

    const result = await runDiscovery({
      catalog: oneQueryCatalog,
      store,
      client,
      signal: new AbortController().signal,
      now: fixedNow,
    });

    expect(store.readCandidates()).toHaveLength(20);
    expect(result.run.state).toBe('complete');
  });

  it('should resume from the first uncommitted page', async () => {
    const store = createStore(oneQueryCatalog);
    store.savePage(
      firstQuery,
      1,
      searchPage([1], true, 2),
      { queryId: firstQuery.id, nextPage: 2, state: 'pending' },
      'committed',
    );
    const requestedPages: number[] = [];
    const client: SearchClient = {
      async search(_query, pageNumber) {
        requestedPages.push(pageNumber);
        return searchPage([2]);
      },
    };

    await runDiscovery({
      catalog: oneQueryCatalog,
      store,
      client,
      signal: new AbortController().signal,
      now: fixedNow,
    });

    expect(requestedPages).toEqual([2]);
    expect(store.readCandidates().map(({ id }) => id)).toEqual([1, 2]);
  });

  it('should reject a changed catalog before making network requests', async () => {
    const store = createStore(oneQueryCatalog);
    const changedCatalog: Catalog = {
      version: 1,
      queries: [{ ...firstQuery, q: 'changed' }],
    };
    let requests = 0;
    const client: SearchClient = {
      async search() {
        requests += 1;
        return searchPage([1]);
      },
    };

    await expect(
      runDiscovery({
        catalog: changedCatalog,
        store,
        client,
        signal: new AbortController().signal,
        now: fixedNow,
      }),
    ).rejects.toThrow(/catalog/i);
    expect(requests).toBe(0);
  });

  it('should continue with later queries after one query fails', async () => {
    const secondQuery: Query = { ...firstQuery, id: 'second', q: 'second' };
    const twoQueryCatalog: Catalog = {
      version: 1,
      queries: [firstQuery, secondQuery],
    };
    const store = createStore(twoQueryCatalog);
    const requestedQueries: string[] = [];
    const client: SearchClient = {
      async search(query) {
        requestedQueries.push(query.id);
        if (query.id === firstQuery.id) throw new Error('temporary failure');
        return searchPage([2]);
      },
    };

    const result = await runDiscovery({
      catalog: twoQueryCatalog,
      store,
      client,
      signal: new AbortController().signal,
      now: fixedNow,
    });

    expect(requestedQueries).toEqual(['first', 'second']);
    expect(store.getCheckpoint('first')).toMatchObject({
      nextPage: 1,
      state: 'failed',
    });
    expect(store.readCandidates().map(({ id }) => id)).toEqual([2]);
    expect(result.run.state).toBe('partial');
  });

  it('should report results above one thousand as capped', async () => {
    const store = createStore(oneQueryCatalog);
    const client: SearchClient = {
      async search() {
        return searchPage([1], false, 1001);
      },
    };

    await runDiscovery({
      catalog: oneQueryCatalog,
      store,
      client,
      signal: new AbortController().signal,
      now: fixedNow,
    });

    expect(store.readCoverage()[0]).toMatchObject({
      capped: true,
      state: 'partial',
    });
  });

  it('should mark incomplete search results as partial', async () => {
    const store = createStore(oneQueryCatalog);
    const client: SearchClient = {
      async search() {
        return searchPage([1], false, 1, true);
      },
    };

    await runDiscovery({
      catalog: oneQueryCatalog,
      store,
      client,
      signal: new AbortController().signal,
      now: fixedNow,
    });

    expect(store.readCoverage()[0]).toMatchObject({
      incomplete: true,
      state: 'partial',
    });
  });

  it('should fetch every page until the query is exhausted', async () => {
    const store = createStore(oneQueryCatalog);
    const requestedPages: number[] = [];
    const client: SearchClient = {
      async search(_query, pageNumber) {
        requestedPages.push(pageNumber);
        return pageNumber === 1
          ? searchPage([1], true, 2)
          : searchPage([2], false, 2);
      },
    };

    const result = await runDiscovery({
      catalog: oneQueryCatalog,
      store,
      client,
      signal: new AbortController().signal,
      now: fixedNow,
    });

    expect(requestedPages).toEqual([1, 2]);
    expect(store.readCandidates().map(({ id }) => id)).toEqual([1, 2]);
    expect(result.run.state).toBe('complete');
  });

  it('should preserve committed pages and leave later queries pending on abort', async () => {
    const secondQuery: Query = { ...firstQuery, id: 'second', q: 'second' };
    const twoQueryCatalog: Catalog = {
      version: 1,
      queries: [firstQuery, secondQuery],
    };
    const store = createStore(twoQueryCatalog);
    const controller = new AbortController();
    const client: SearchClient = {
      async search(query, pageNumber) {
        if (query.id === firstQuery.id && pageNumber === 1) {
          return searchPage([1], true, 2);
        }
        controller.abort(new Error('interrupted'));
        throw new Error('interrupted');
      },
    };

    const result = await runDiscovery({
      catalog: twoQueryCatalog,
      store,
      client,
      signal: controller.signal,
      now: fixedNow,
    });

    expect(store.readCandidates().map(({ id }) => id)).toEqual([1]);
    expect(store.getCheckpoint('first')).toMatchObject({
      nextPage: 2,
      state: 'failed',
    });
    expect(store.getCheckpoint('second')).toMatchObject({
      nextPage: 1,
      state: 'pending',
    });
    expect(result.run.state).toBe('partial');
  });

  it('should cap a query that still has another page after page ten', async () => {
    const store = createStore(oneQueryCatalog);
    const requestedPages: number[] = [];
    const client: SearchClient = {
      async search(_query, pageNumber) {
        requestedPages.push(pageNumber);
        return searchPage([pageNumber], true, 1000);
      },
    };

    await runDiscovery({
      catalog: oneQueryCatalog,
      store,
      client,
      signal: new AbortController().signal,
      now: fixedNow,
    });

    expect(requestedPages).toHaveLength(10);
    expect(store.getCheckpoint('first')).toMatchObject({
      nextPage: null,
      state: 'partial',
    });
    expect(store.readCoverage()[0].capped).toBe(true);
  });
});
