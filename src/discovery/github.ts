import type { Query, SearchClient, SearchHit, SearchPage } from './types.js';

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const PAGE_SIZE = 100;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;

type EndpointState = { nextRequestAt: number };
type JsonRecord = Record<string, unknown>;

type GitHubClientOptions = {
  token: string;
  fetchFn: typeof fetch;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
};

/** Creates a rate-aware GitHub Search API client without persisting credentials. */
export function createGitHubClient(options: GitHubClientOptions): SearchClient {
  const endpointStates = new Map<Query['endpoint'], EndpointState>();

  const stateFor = (endpoint: Query['endpoint']): EndpointState => {
    let state = endpointStates.get(endpoint);
    if (!state) {
      state = { nextRequestAt: 0 };
      endpointStates.set(endpoint, state);
    }
    return state;
  };

  return {
    async search(query, page, signal) {
      const endpointState = stateFor(query.endpoint);
      const minimumInterval = query.endpoint === 'repositories' ? 2_000 : 6_000;
      const url = buildSearchUrl(query, page);
      let retryAt = 0;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        throwIfAborted(signal, options.token);
        const waitMs = Math.max(
          0,
          endpointState.nextRequestAt - options.now(),
          retryAt - options.now(),
        );
        if (waitMs > 0)
          await sleepAbortably(options.sleep, waitMs, signal, options.token);
        throwIfAborted(signal, options.token);

        const startedAt = options.now();
        endpointState.nextRequestAt = Math.max(
          endpointState.nextRequestAt,
          startedAt + minimumInterval,
        );

        let response: Response;
        try {
          response = await fetchWithTimeout(options, url, signal);
        } catch (error) {
          if (signal.aborted)
            throw sanitizedError(signal.reason, options.token);
          if (attempt === MAX_ATTEMPTS - 1) {
            throw new Error(
              `GitHub request failed: ${redact(errorMessage(error), options.token)}`,
            );
          }
          retryAt = options.now() + retryDelay(attempt);
          continue;
        }

        const retryHeaderAt = retryAfterAt(response.headers, options.now());
        if (retryHeaderAt !== null) {
          endpointState.nextRequestAt = Math.max(
            endpointState.nextRequestAt,
            retryHeaderAt,
          );
        }
        const serverResetAt = rateLimitResetAt(response.headers);
        if (
          response.headers.get('x-ratelimit-remaining') === '0' &&
          serverResetAt !== null
        ) {
          endpointState.nextRequestAt = Math.max(
            endpointState.nextRequestAt,
            serverResetAt,
          );
        }

        if (response.ok) {
          const payload = await readJson(response, options.token);
          return normalizeSearchPage(
            query,
            payload,
            response.headers.get('link'),
          );
        }

        if (await isRateLimitResponse(response)) {
          applyRateLimitDelay(response, endpointState, options.now());
          if (attempt === MAX_ATTEMPTS - 1) {
            throw responseError(response, options.token);
          }
          retryAt = 0;
          continue;
        }

        if (response.status >= 500 && response.status <= 599) {
          if (attempt === MAX_ATTEMPTS - 1)
            throw responseError(response, options.token);
          retryAt = options.now() + retryDelay(attempt);
          continue;
        }

        throw responseError(response, options.token);
      }

      throw new Error('GitHub request failed after the retry limit');
    },
  };
}

function buildSearchUrl(query: Query, page: number): URL {
  const url = new URL(`${API_ROOT}/search/${query.endpoint}`);
  url.searchParams.set('q', query.q);
  url.searchParams.set('per_page', String(PAGE_SIZE));
  url.searchParams.set('page', String(page));
  return url;
}

async function fetchWithTimeout(
  options: GitHubClientOptions,
  url: URL,
  callerSignal: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal.reason);
  callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error('GitHub request timed out')),
    REQUEST_TIMEOUT_MS,
  );

  try {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    const response = await options.fetchFn(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'repo-discovery/0.1.0',
      },
      signal: controller.signal,
    });
    // Read a clone while the timer is active so a stalled response body also times out.
    await response.clone().arrayBuffer();
    return response;
  } finally {
    clearTimeout(timeout);
    callerSignal.removeEventListener('abort', onCallerAbort);
  }
}

async function isRateLimitResponse(response: Response): Promise<boolean> {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  if (response.headers.has('retry-after')) return true;
  if (response.headers.get('x-ratelimit-remaining') === '0') return true;
  try {
    const payload: unknown = await response.clone().json();
    return (
      isRecord(payload) &&
      typeof payload.message === 'string' &&
      /rate[ -]limit/i.test(payload.message)
    );
  } catch {
    return false;
  }
}

function applyRateLimitDelay(
  response: Response,
  endpointState: EndpointState,
  now: number,
): void {
  const retryAt = retryAfterAt(response.headers, now);
  const resetAt = rateLimitResetAt(response.headers);
  const serverAt = Math.max(retryAt ?? 0, resetAt ?? 0);
  endpointState.nextRequestAt = Math.max(
    endpointState.nextRequestAt,
    serverAt || now + 60_000,
  );
}

function retryAfterAt(headers: Headers, now: number): number | null {
  const retryAfter = headers.get('retry-after');
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return now + Math.max(0, seconds * 1_000);
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? null : Math.max(now, date);
}

function rateLimitResetAt(headers: Headers): number | null {
  const reset = headers.get('x-ratelimit-reset');
  if (!reset) return null;
  const epochSeconds = Number(reset);
  return Number.isFinite(epochSeconds) ? epochSeconds * 1_000 : null;
}

function normalizeSearchPage(
  query: Query,
  payload: unknown,
  linkHeader: string | null,
): SearchPage {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error('GitHub returned an invalid search response');
  }
  const totalCount = payload.total_count;
  if (typeof totalCount !== 'number' || !Number.isInteger(totalCount)) {
    throw new Error('GitHub returned an invalid search total_count');
  }

  const hits = payload.items.map((item, index) =>
    query.endpoint === 'repositories'
      ? normalizeRepositoryHit(item, index)
      : normalizeCodeHit(item, index),
  );
  return {
    totalCount,
    incomplete: payload.incomplete_results === true,
    hits,
    hasNext: hasValidNextLink(linkHeader, query.endpoint),
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

function normalizeCandidate(value: JsonRecord, index: number) {
  if (
    typeof value.id !== 'number' ||
    typeof value.full_name !== 'string' ||
    typeof value.html_url !== 'string'
  ) {
    throw new Error(`Invalid repository metadata at index ${index}`);
  }
  return {
    id: value.id,
    fullName: value.full_name,
    url: value.html_url,
    metadata: value,
  };
}

function hasValidNextLink(
  linkHeader: string | null,
  endpoint: Query['endpoint'],
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

async function readJson(response: Response, token: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(
      `GitHub returned invalid JSON: ${redact(errorMessage(error), token)}`,
    );
  }
}

function responseError(response: Response, token: string): Error {
  return new Error(
    `GitHub API request failed (${response.status} ${redact(response.statusText, token)})`,
  );
}

function retryDelay(attempt: number): number {
  return 1_000 * 2 ** attempt;
}

async function sleepAbortably(
  sleep: GitHubClientOptions['sleep'],
  ms: number,
  signal: AbortSignal,
  token: string,
): Promise<void> {
  throwIfAborted(signal, token);
  try {
    await sleep(ms, signal);
  } catch (error) {
    if (signal.aborted) throw sanitizedError(signal.reason, token);
    throw sanitizedError(error, token);
  }
}

function throwIfAborted(signal: AbortSignal, token: string): void {
  if (signal.aborted)
    throw sanitizedError(signal.reason ?? new Error('Request aborted'), token);
}

function sanitizedError(error: unknown, token: string): Error {
  return new Error(redact(errorMessage(error), token));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(message: string, token: string): string {
  return token.length > 0 ? message.split(token).join('[REDACTED]') : message;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
