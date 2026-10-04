import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCatalog } from '../src/discovery/catalog.js';
import { openStore } from '../src/discovery/storage.js';
import type { Query, SearchPage } from '../src/discovery/types.js';

const repositoryQuery: Query = {
  id: 'repository-query',
  strategy: 'terminology',
  endpoint: 'repositories',
  q: 'microfrontend in:name,description,readme',
};
const codeQuery: Query = {
  id: 'code-query',
  strategy: 'technology',
  endpoint: 'code',
  q: 'single-spa in:file',
};
const catalog = parseCatalog({
  version: 1,
  queries: [repositoryQuery, codeQuery],
});
const openStores: ReturnType<typeof openStore>[] = [];
const tempDirs: string[] = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), 'discovery-storage-'));
  tempDirs.push(directory);
  const store = openStore(join(directory, 'discovery.sqlite'));
  openStores.push(store);
  store.createRun(catalog, 'catalog-hash', '2026-10-04T00:00:00.000Z');
  return { directory, store };
}

function searchPage(
  repositoryId: number,
  paths: Array<string | null> = [null],
): SearchPage {
  const fullName = `org/repository-${repositoryId}`;
  return {
    totalCount: 1,
    incomplete: false,
    hasNext: false,
    hits: paths.map((path) => ({
      candidate: {
        id: repositoryId,
        fullName,
        url: `https://github.com/${fullName}`,
        metadata: { stars: 7 },
      },
      path,
      url: path
        ? `https://github.com/${fullName}/blob/main/${path}`
        : `https://github.com/${fullName}`,
    })),
  };
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('discovery storage', () => {
  it('should keep one candidate with both discovery origins', () => {
    const { store } = createStore();
    store.savePage(
      repositoryQuery,
      1,
      searchPage(101),
      { queryId: repositoryQuery.id, nextPage: null, state: 'complete' },
      '2026-10-04T00:01:00.000Z',
    );
    store.savePage(
      codeQuery,
      1,
      searchPage(101),
      { queryId: codeQuery.id, nextPage: null, state: 'complete' },
      '2026-10-04T00:02:00.000Z',
    );

    expect(store.readCandidates()).toHaveLength(1);
    expect(
      store
        .readHits()
        .map((hit) => hit.queryId)
        .sort(),
    ).toEqual(['code-query', 'repository-query']);
  });

  it('should keep distinct code paths for the same repository', () => {
    const { store } = createStore();
    store.savePage(
      codeQuery,
      1,
      searchPage(202, ['./src/../src/App.tsx', 'src/remote.ts']),
      { queryId: codeQuery.id, nextPage: null, state: 'complete' },
      '2026-10-04T00:01:00.000Z',
    );

    expect(
      store
        .readHits()
        .map((hit) => hit.path)
        .sort(),
    ).toEqual(['src/App.tsx', 'src/remote.ts']);
  });

  it('should make replaying a committed page idempotent', () => {
    const { store } = createStore();
    const result = searchPage(303);
    const checkpoint = {
      queryId: repositoryQuery.id,
      nextPage: null,
      state: 'complete' as const,
    };

    store.savePage(repositoryQuery, 1, result, checkpoint, 'first-fetch');
    // A re-fetch may see a changed GitHub index; the committed page is the snapshot.
    store.savePage(repositoryQuery, 1, searchPage(999), checkpoint, 'replay');

    expect(store.readHits()).toHaveLength(1);
    expect(store.readCandidates().map((candidate) => candidate.id)).toEqual([
      303,
    ]);
    expect(store.readCoverage()[0].fetchedPages).toBe(1);
  });

  it('should roll back page data when checkpoint persistence fails', () => {
    const { store } = createStore();

    expect(() =>
      store.savePage(
        repositoryQuery,
        1,
        searchPage(404),
        { queryId: repositoryQuery.id, nextPage: 0, state: 'pending' },
        '2026-10-04T00:01:00.000Z',
      ),
    ).toThrow();

    expect(store.readHits()).toHaveLength(0);
    expect(store.getCheckpoint(repositoryQuery.id)).toEqual({
      queryId: repositoryQuery.id,
      nextPage: 1,
      state: 'pending',
    });
  });

  it('should recover committed progress after reopening the database', () => {
    const { directory, store } = createStore();
    store.savePage(
      repositoryQuery,
      1,
      searchPage(505),
      { queryId: repositoryQuery.id, nextPage: 2, state: 'pending' },
      '2026-10-04T00:01:00.000Z',
    );
    store.close();
    openStores.splice(openStores.indexOf(store), 1);

    const reopened = openStore(join(directory, 'discovery.sqlite'));
    openStores.push(reopened);
    expect(reopened.getCheckpoint(repositoryQuery.id).nextPage).toBe(2);
    expect(reopened.readCandidates()).toHaveLength(1);
  });
});
