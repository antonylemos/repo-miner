const API_VERSION = '2026-03-10';
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;

type LaneState = { nextRequestAt: number };
type JsonRecord = Record<string, unknown>;

export type HttpClientOptions = {
  token: string;
  fetchFn: typeof fetch;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
};

export type HttpRequest = {
  url: URL;
  /** Requests on the same lane share pacing and rate-limit waits. */
  lane: string;
  minimumIntervalMs: number;
  method?: 'GET' | 'POST';
  body?: string;
};

/** Sends GitHub API requests with per-lane pacing, timeouts, retries and token redaction. */
export function createHttpClient(options: HttpClientOptions) {
  const lanes = new Map<string, LaneState>();

  const laneFor = (name: string): LaneState => {
    let state = lanes.get(name);
    if (!state) {
      state = { nextRequestAt: 0 };
      lanes.set(name, state);
    }
    return state;
  };

  return {
    async send(request: HttpRequest, signal: AbortSignal): Promise<Response> {
      const lane = laneFor(request.lane);
      let retryAt = 0;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        throwIfAborted(signal, options.token);
        const waitMs = Math.max(
          0,
          lane.nextRequestAt - options.now(),
          retryAt - options.now(),
        );
        if (waitMs > 0)
          await sleepAbortably(options.sleep, waitMs, signal, options.token);
        throwIfAborted(signal, options.token);

        const startedAt = options.now();
        lane.nextRequestAt = Math.max(
          lane.nextRequestAt,
          startedAt + request.minimumIntervalMs,
        );

        let response: Response;
        try {
          response = await fetchWithTimeout(options, request, signal);
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
          lane.nextRequestAt = Math.max(lane.nextRequestAt, retryHeaderAt);
        }
        const serverResetAt = rateLimitResetAt(response.headers);
        if (
          response.headers.get('x-ratelimit-remaining') === '0' &&
          serverResetAt !== null
        ) {
          lane.nextRequestAt = Math.max(lane.nextRequestAt, serverResetAt);
        }

        if (response.ok) return response;

        if (await isRateLimitResponse(response)) {
          applyRateLimitDelay(response, lane, options.now());
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

async function fetchWithTimeout(
  options: HttpClientOptions,
  request: HttpRequest,
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
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${options.token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'repo-miner/0.1.0',
    };
    if (request.body !== undefined)
      headers['Content-Type'] = 'application/json';
    const response = await options.fetchFn(request.url, {
      method: request.method ?? 'GET',
      headers,
      body: request.body,
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
  lane: LaneState,
  now: number,
): void {
  const retryAt = retryAfterAt(response.headers, now);
  const resetAt = rateLimitResetAt(response.headers);
  const serverAt = Math.max(retryAt ?? 0, resetAt ?? 0);
  lane.nextRequestAt = Math.max(lane.nextRequestAt, serverAt || now + 60_000);
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

export async function readJson(
  response: Response,
  token: string,
): Promise<unknown> {
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
  sleep: HttpClientOptions['sleep'],
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

export function redact(message: string, token: string): string {
  return token.length > 0 ? message.split(token).join('[REDACTED]') : message;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
