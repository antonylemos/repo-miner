import {
  createHttpClient,
  type HttpClientOptions,
  isRecord,
  readJson,
} from './http.js';
import type {
  Candidate,
  CountClient,
  Endpoint,
  SearchClient,
  SearchCount,
  SearchHit,
  SearchPage,
  Subquery,
} from './types.js';

const API_ROOT = 'https://api.github.com';
const PAGE_SIZE = 100;

/** Creates a rate-aware GitHub Search API client without persisting credentials. */
export function createGitHubClient(
  options: HttpClientOptions,
): SearchClient & CountClient {
  const http = createHttpClient(options);

  const fetchPage = async (
    subquery: Subquery,
    page: number,
    perPage: number,
    signal: AbortSignal,
  ) => {
    const response = await http.send(
      {
        url: buildSearchUrl(subquery, page, perPage),
        lane: subquery.endpoint,
        minimumIntervalMs: subquery.endpoint === 'repositories' ? 2_000 : 6_000,
      },
      signal,
    );
    return {
      payload: await readJson(response, options.token),
      link: response.headers.get('link'),
    };
  };

  return {
    async search(subquery, page, signal) {
      const { payload, link } = await fetchPage(
        subquery,
        page,
        PAGE_SIZE,
        signal,
      );
      return normalizeSearchPage(subquery, payload, link);
    },
    async count(subquery, signal) {
      const { payload } = await fetchPage(subquery, 1, 1, signal);
      return readTotals(payload).count;
    },
  };
}

function buildSearchUrl(
  subquery: Subquery,
  page: number,
  perPage: number,
): URL {
  const url = new URL(`${API_ROOT}/search/${subquery.endpoint}`);
  url.searchParams.set('q', subquery.q);
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('page', String(page));
  return url;
}

function readTotals(payload: unknown): {
  count: SearchCount;
  items: unknown[];
} {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error('GitHub returned an invalid search response');
  }
  const totalCount = payload.total_count;
  if (typeof totalCount !== 'number' || !Number.isInteger(totalCount)) {
    throw new Error('GitHub returned an invalid search total_count');
  }
  return {
    count: { totalCount, incomplete: payload.incomplete_results === true },
    items: payload.items,
  };
}

function normalizeSearchPage(
  subquery: Subquery,
  payload: unknown,
  linkHeader: string | null,
): SearchPage {
  const { count, items } = readTotals(payload);
  const hits = items.map((item, index) =>
    subquery.endpoint === 'repositories'
      ? normalizeRepositoryHit(item, index)
      : normalizeCodeHit(item, index),
  );
  return {
    ...count,
    hits,
    hasNext: hasValidNextLink(linkHeader, subquery.endpoint),
  };
}

function normalizeRepositoryHit(value: unknown, index: number): SearchHit {
  if (!isRecord(value))
    throw new Error(`Invalid repository search item at index ${index}`);
  const candidate = normalizeCandidate(value, index);
  return { candidate, path: null, url: candidate.url };
}

function normalizeCodeHit(value: unknown, index: number): SearchHit {
  if (!isRecord(value) || !isRecord(value.repository)) {
    throw new Error(`Invalid code search item at index ${index}`);
  }
  const candidate = normalizeCandidate(value.repository, index);
  const path = typeof value.path === 'string' ? value.path : null;
  const url =
    typeof value.html_url === 'string' ? value.html_url : candidate.url;
  return { candidate, path, url };
}

function normalizeCandidate(
  value: Record<string, unknown>,
  index: number,
): Candidate {
  if (
    typeof value.id !== 'number' ||
    typeof value.node_id !== 'string' ||
    typeof value.full_name !== 'string' ||
    typeof value.html_url !== 'string'
  ) {
    throw new Error(`Invalid repository metadata at index ${index}`);
  }
  return {
    id: value.id,
    nodeId: value.node_id,
    fullName: value.full_name,
    url: value.html_url,
    metadata: value,
  };
}

function hasValidNextLink(
  linkHeader: string | null,
  endpoint: Endpoint,
): boolean {
  if (!linkHeader) return false;
  const expectedPath = `/search/${endpoint}`;
  const linkPattern = /<([^>]+)>\s*;\s*rel\s*=\s*"?([^";, ]+)"?/g;
  for (const match of linkHeader.matchAll(linkPattern)) {
    if (match[2] !== 'next') continue;
    try {
      const url = new URL(match[1]);
      if (url.origin === API_ROOT && url.pathname === expectedPath) return true;
    } catch {
      // Invalid or non-absolute links cannot be followed by this client.
    }
  }
  return false;
}
