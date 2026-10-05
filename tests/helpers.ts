import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogHash } from '../src/discovery/catalog.js';
import { expandCatalog } from '../src/discovery/expansion.js';
import { type DiscoveryStore, openStore } from '../src/discovery/storage.js';
import type {
  Catalog,
  Query,
  SearchHit,
  SearchPage,
} from '../src/discovery/types.js';

const openStores: DiscoveryStore[] = [];
const tempDirs: string[] = [];

export function query(overrides: Partial<Query> & Pick<Query, 'id'>): Query {
  return {
    strategy: 'terminology',
    endpoint: 'repositories',
    q: overrides.id,
    rationale: 'test query',
    ...overrides,
  };
}

export function catalogOf(
  queries: Query[],
  pushedSince = '2024-01-01',
): Catalog {
  return { version: 2, filters: { pushedSince }, queries };
}

/** Builds a hit; metadata defaults to an in-scope repository-search record. */
export function hit(
  id: number,
  options: { path?: string | null; metadata?: Record<string, unknown> } = {},
): SearchHit {
  const fullName = `org/repo-${id}`;
  const path = options.path ?? null;
  return {
    candidate: {
      id,
      nodeId: `R_${id}`,
      fullName,
      url: `https://github.com/${fullName}`,
      metadata: options.metadata ?? { pushed_at: '2025-01-01T00:00:00Z' },
    },
    path,
    url: path
      ? `https://github.com/${fullName}/blob/main/${path}`
      : `https://github.com/${fullName}`,
  };
}

export function page(
  hits: SearchHit[],
  options: {
    hasNext?: boolean;
    totalCount?: number;
    incomplete?: boolean;
  } = {},
): SearchPage {
  return {
    hits,
    hasNext: options.hasNext ?? false,
    totalCount: options.totalCount ?? hits.length,
    incomplete: options.incomplete ?? false,
  };
}

export function createTestStore(
  catalog: Catalog,
  expansionDate = '2026-10-05',
) {
  const directory = mkdtempSync(join(tmpdir(), 'discovery-test-'));
  tempDirs.push(directory);
  const store = trackStore(openStore(join(directory, 'discovery.sqlite')));
  const subqueries = expandCatalog(catalog, expansionDate);
  store.createRun({
    catalog,
    hash: catalogHash(catalog),
    startedAt: '2026-10-05T00:00:00.000Z',
    expansionDate,
    subqueries,
  });
  return { directory, store, subqueries };
}

export function trackStore(store: DiscoveryStore): DiscoveryStore {
  openStores.push(store);
  return store;
}

export function cleanupTestStores(): void {
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      // A test may already have closed the store to reopen the file.
    }
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Minimal RFC 4180 parser for asserting exported CSV files. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
