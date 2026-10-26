import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@/common/records.js';
import {
  createHttpClient,
  type HttpClientOptions,
  readJson,
} from '@/modules/discovery/http/client.js';

/** One response of the GitHub API, as kept on disk. */
export type CachedPage = {
  /** The address that was asked for. */
  url: string;
  fetchedAt: string;
  status: number;
  /** Null for a status other than 200. */
  body: unknown;
  /** The `rel="next"` link of the response. */
  next: string | null;
};

export type PagedResult = {
  pages: CachedPage[];
  /** 200, or the 404 or 451 that ended the list. */
  status: number;
};

export type PagedRequest = {
  /** Directory name of the repository, `<owner>__<name>`. */
  repository: string;
  endpoint: string;
  /** First page. */
  url: string;
  accept?: string;
};

export type ApiCacheOptions = {
  /** Where the pages are kept. */
  directory: string;
  /** Needed only when a page is not on disk. */
  token: string | undefined;
  http: Omit<HttpClientOptions, 'token'>;
  signal?: AbortSignal;
};

const MINIMUM_INTERVAL_MS = 500;
/** Statuses that say the repository cannot be read, not that the request failed. */
const UNAVAILABLE = [404, 451];

function nextLink(header: string | null): string | null {
  for (const part of (header ?? '').split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match !== null) return match[1] as string;
  }
  return null;
}

/** The HTTP client reports a failed response only in the message. */
function failedStatus(error: unknown): number | null {
  const match = /^GitHub API request failed \((\d{3}) /.exec(
    error instanceof Error ? error.message : '',
  );
  return match === null ? null : Number(match[1]);
}

/** A page on disk for the address, or null when it is missing, damaged or for another address. */
function readPage(path: string, url: string): CachedPage | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.url !== url ||
    typeof value.fetchedAt !== 'string' ||
    typeof value.status !== 'number' ||
    !(typeof value.next === 'string' || value.next === null)
  )
    return null;
  return value as CachedPage;
}

function writePage(path: string, page: CachedPage): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(page)}\n`);
  renameSync(temporary, path);
}

/**
 * Lists paginated GitHub resources, keeping every response under
 * `<directory>/<repository>/<endpoint>-<n>.json` as soon as it arrives. A page
 * on disk is used instead of asking again, and `GITHUB_TOKEN` is needed only
 * for a page that is not.
 */
export function createApiCache(options: ApiCacheOptions) {
  const signal = options.signal ?? new AbortController().signal;
  let client: ReturnType<typeof createHttpClient> | null = null;
  let fetched = 0;

  const fetchPage = async (
    request: PagedRequest,
    url: string,
  ): Promise<CachedPage> => {
    if (options.token === undefined || options.token === '')
      throw new Error(
        `GITHUB_TOKEN is required to fetch ${url}, which is not in the cache.`,
      );
    client ??= createHttpClient({ ...options.http, token: options.token });
    const fetchedAt = new Date(options.http.now()).toISOString();
    try {
      const response = await client.send(
        {
          url: new URL(url),
          lane: 'profile',
          minimumIntervalMs: MINIMUM_INTERVAL_MS,
          accept: request.accept,
        },
        signal,
      );
      return {
        url,
        fetchedAt,
        status: response.status,
        body: await readJson(response, options.token),
        next: nextLink(response.headers.get('link')),
      };
    } catch (error) {
      const status = failedStatus(error);
      if (status === null || !UNAVAILABLE.includes(status)) throw error;
      return { url, fetchedAt, status, body: null, next: null };
    }
  };

  return {
    /** Pages fetched from the API, not read from disk. */
    fetchedPages: () => fetched,

    async collect(request: PagedRequest): Promise<PagedResult> {
      const directory = join(options.directory, request.repository);
      mkdirSync(directory, { recursive: true });
      const pages: CachedPage[] = [];
      let url: string | null = request.url;
      for (let number = 1; url !== null; number += 1) {
        const path = join(directory, `${request.endpoint}-${number}.json`);
        let page = readPage(path, url);
        if (page === null) {
          page = await fetchPage(request, url);
          writePage(path, page);
          fetched += 1;
        }
        pages.push(page);
        if (page.status !== 200) return { pages, status: page.status };
        url = page.next;
      }
      return { pages, status: 200 };
    },
  };
}
