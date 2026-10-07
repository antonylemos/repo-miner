import type { CommitFact, CommitIdentity } from '../eligibility/types.js';
import {
  createHttpClient,
  type HttpClientOptions,
  isRecord,
  readJson,
  redact,
} from '../http.js';
import type {
  ActivityClient,
  ActivityHooks,
  ActivityTarget,
  BranchFact,
  CollectionLimits,
} from './types.js';

const ROOT = 'https://api.github.com';
const invalid = () => new Error('GitHub returned invalid activity facts');

/** Captures immutable branch heads and commit facts; pagination links are never followed. */
export function createActivityClient(
  options: HttpClientOptions,
  limits: CollectionLimits,
  hooks: ActivityHooks,
): ActivityClient {
  for (const size of [limits.branchesPerPage, limits.commitsPerPage]) {
    if (!Number.isInteger(size) || size < 1 || size > 100)
      throw new Error('Invalid activity page size');
  }
  const http = createHttpClient(options);
  const read = async (url: URL, signal: AbortSignal) => {
    const response = await http.send(
      {
        url,
        lane: 'activity',
        minimumIntervalMs: 1000,
        ...hooks,
        redirect: 'error',
      },
      signal,
    );
    const payload = await readJson(response, options.token);
    const raw = redactPayload(payload, options.token);
    return {
      raw,
      observedAt: new Date(options.now()).toISOString(),
      requestUrl: redact(url.href, options.token),
      link: response.headers.get('link'),
    };
  };
  return {
    async readBranch(target, branch, signal) {
      if (!branch) throw invalid();
      const response = await read(
        repositoryUrl(target, `branches/${encodeURIComponent(branch)}`),
        signal,
      );
      const ref = branchFact(response.raw, response.observedAt);
      if (ref.name !== redact(branch, options.token)) throw invalid();
      const { link: _link, ...observation } = response;
      return { ...observation, ref };
    },
    async listBranches(target, page, signal) {
      const url = pageUrl(
        repositoryUrl(target, 'branches'),
        page,
        limits.branchesPerPage,
      );
      const response = await read(url, signal);
      if (
        !Array.isArray(response.raw) ||
        response.raw.length > limits.branchesPerPage
      )
        throw invalid();
      const items = response.raw.map((value) =>
        branchFact(value, response.observedAt),
      );
      const { link, ...observation } = response;
      return {
        ...observation,
        items,
        hasNext: hasNext(link, url, items.length, limits.branchesPerPage),
      };
    },
    async listCommits(target, headSha, interval, page, signal) {
      validateSha(headSha);
      const since = timestamp(interval.since);
      const until = timestamp(interval.until);
      const lower = since - 1000;
      const upper = until + 1000;
      if (
        since > until ||
        lower < Date.UTC(1970, 0, 1) ||
        upper >= Date.UTC(2100, 0, 1)
      )
        throw new Error('Unsupported GitHub activity timestamp range');
      const url = pageUrl(
        repositoryUrl(target, 'commits'),
        page,
        limits.commitsPerPage,
      );
      url.searchParams.set('sha', headSha);
      url.searchParams.set('since', new Date(lower).toISOString());
      url.searchParams.set('until', new Date(upper).toISOString());
      const response = await read(url, signal);
      if (
        !Array.isArray(response.raw) ||
        response.raw.length > limits.commitsPerPage
      )
        throw invalid();
      const items = response.raw.map((value) =>
        commitFact(value, target.repositoryId, response.observedAt),
      );
      const { link, ...observation } = response;
      return {
        ...observation,
        items,
        hasNext: hasNext(link, url, items.length, limits.commitsPerPage),
      };
    },
  };
}

function redactPayload(value: unknown, token: string): unknown {
  if (typeof value === 'string') return redact(value, token);
  if (Array.isArray(value))
    return value.map((item) => redactPayload(item, token));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key, token),
        redactPayload(item, token),
      ]),
    );
  return value;
}

function repositoryUrl(target: ActivityTarget, suffix: string): URL {
  const parts = target.fullName.split('/');
  if (
    parts.length !== 2 ||
    parts.some((p) => !p || p === '.' || p === '..') ||
    !Number.isSafeInteger(target.repositoryId) ||
    target.repositoryId < 1
  )
    throw invalid();
  return new URL(
    `${ROOT}/repos/${parts.map(encodeURIComponent).join('/')}/${suffix}`,
  );
}
function pageUrl(url: URL, page: number, size: number): URL {
  if (!Number.isSafeInteger(page) || page < 1) throw invalid();
  url.searchParams.set('per_page', String(size));
  url.searchParams.set('page', String(page));
  return url;
}
function hasNext(
  link: string | null,
  expected: URL,
  count: number,
  size: number,
): boolean {
  if (link) {
    let next = false;
    for (const part of link.split(/,(?=\s*<)/)) {
      const match = /^\s*<([^>]+)>\s*;(.*)$/.exec(part);
      if (!match) throw new Error('Invalid activity pagination');
      const rel = /(?:^|;)\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/.exec(
        match[2] ?? '',
      );
      if (!rel) throw new Error('Invalid activity pagination');
      if (!(rel[1] ?? rel[2] ?? '').split(/\s+/).includes('next')) continue;
      if (next) throw new Error('Invalid activity pagination');
      let received: URL;
      try {
        received = new URL(match[1] ?? '');
      } catch {
        throw new Error('Invalid activity pagination');
      }
      const wanted = new URL(expected);
      wanted.searchParams.set(
        'page',
        String(Number(expected.searchParams.get('page')) + 1),
      );
      if (
        received.origin !== wanted.origin ||
        received.pathname !== wanted.pathname ||
        received.username ||
        received.password ||
        received.hash ||
        received.searchParams.size !== wanted.searchParams.size ||
        [...wanted.searchParams].some(
          ([k, v]) =>
            received.searchParams.getAll(k).length !== 1 ||
            received.searchParams.get(k) !== v,
        )
      )
        throw new Error('Invalid activity pagination');
      next = true;
    }
    if (next) return true;
  }
  return count === size;
}
function validateSha(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{40}$/.test(value))
    throw invalid();
}
function branchFact(value: unknown, observedAt: string): BranchFact {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    !value.name ||
    !isRecord(value.commit)
  )
    throw invalid();
  validateSha(value.commit.sha);
  return { name: value.name, headSha: value.commit.sha, observedAt };
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string') throw invalid();
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!m) throw invalid();
  const [, y, mo, d, h, mi, s, tz] = m;
  const year = Number(y),
    month = Number(mo),
    day = Number(d);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    Number(s) > 59 ||
    (tz !== 'Z' && (Number(tz?.slice(1, 3)) > 23 || Number(tz?.slice(4)) > 59))
  )
    throw invalid();
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw invalid();
  return result;
}
function identity(git: unknown, account: unknown): CommitIdentity {
  if (!isRecord(git) || !('name' in git) || !('email' in git)) throw invalid();
  const nullable = (v: unknown): string | null => {
    if (v === null || typeof v === 'string') return v;
    throw invalid();
  };
  if (account !== null && !isRecord(account)) throw invalid();
  return {
    name: nullable(git.name),
    email: nullable(git.email),
    account:
      account === null
        ? null
        : {
            login: nullable(account.login),
            providerType: nullable(account.type),
          },
  };
}
function commitFact(
  value: unknown,
  repositoryId: number,
  observedAt: string,
): CommitFact {
  if (
    !isRecord(value) ||
    !isRecord(value.commit) ||
    !isRecord(value.commit.author) ||
    !isRecord(value.commit.committer)
  )
    throw invalid();
  validateSha(value.sha);
  timestamp(value.commit.author.date);
  timestamp(value.commit.committer.date);
  return {
    repositoryId,
    sha: value.sha,
    authoredDate: value.commit.author.date as string,
    committedDate: value.commit.committer.date as string,
    author: identity(value.commit.author, value.author),
    committer: identity(value.commit.committer, value.committer),
    observedAt,
  };
}
