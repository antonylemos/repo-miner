import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { Coverage, Query, StoredHit, Strategy } from '../types.js';

export type CandidateRow = { id: number; strategies: Strategy[] };
export const STRATEGIES: Strategy[] = ['terminology', 'technology', 'broader'];
/** Search metadata kept in candidates.csv; API URL templates and `owner` stay only in SQLite. */
const METADATA_FIELDS = [
  'description',
  'topics',
  'language',
  'license',
  'created_at',
  'pushed_at',
  'size',
  'stargazers_count',
  'forks_count',
  'archived',
  'fork',
  'default_branch',
  'homepage',
];
export const HIT_COLUMNS = [
  'query_id',
  'subquery_id',
  'strategy',
  'endpoint',
  'q_effective',
  'fetched_at',
  'candidate_id',
  'full_name',
  'repository_url',
  'path',
  'url',
];

export type Intersections = {
  exclusive: Record<Strategy, number>;
  pairs: Array<{ left: Strategy; right: Strategy; count: number }>;
  all: number;
};
export type QueryCoverage = {
  queryId: string;
  strategy: Strategy;
  subqueries: number;
  complete: number;
  partial: number;
  failed: number;
  pending: number;
  hits: number;
  uniqueCandidates: number;
};

export function strategiesByCandidate(
  hits: StoredHit[],
): Map<number, Set<Strategy>> {
  const strategiesById = new Map<number, Set<Strategy>>();
  for (const hit of hits) {
    const found = strategiesById.get(hit.candidate.id) ?? new Set<Strategy>();
    found.add(hit.strategy);
    strategiesById.set(hit.candidate.id, found);
  }
  return strategiesById;
}

export function exportedMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    METADATA_FIELDS.filter((field) => field in metadata).map((field) => [
      field,
      metadata[field],
    ]),
  );
}

export function strategyCounts(rows: CandidateRow[]): Record<Strategy, number> {
  return Object.fromEntries(
    STRATEGIES.map((strategy) => [
      strategy,
      rows.filter((row) => row.strategies.includes(strategy)).length,
    ]),
  ) as Record<Strategy, number>;
}

export function intersections(rows: CandidateRow[]): Intersections {
  const has = (row: CandidateRow, strategy: Strategy) =>
    row.strategies.includes(strategy);
  const exclusive = Object.fromEntries(
    STRATEGIES.map((strategy) => [
      strategy,
      rows.filter((row) => row.strategies.length === 1 && has(row, strategy))
        .length,
    ]),
  ) as Record<Strategy, number>;
  const pairs: Intersections['pairs'] = [];
  for (let left = 0; left < STRATEGIES.length; left += 1) {
    for (let right = left + 1; right < STRATEGIES.length; right += 1) {
      pairs.push({
        left: STRATEGIES[left],
        right: STRATEGIES[right],
        count: rows.filter(
          (row) => has(row, STRATEGIES[left]) && has(row, STRATEGIES[right]),
        ).length,
      });
    }
  }
  const all = rows.filter((row) =>
    STRATEGIES.every((strategy) => has(row, strategy)),
  ).length;
  return { exclusive, pairs, all };
}

export function queryCoverage(
  queries: Query[],
  coverage: Coverage[],
  hits: StoredHit[],
): QueryCoverage[] {
  return queries.map((query) => {
    const entries = coverage.filter((entry) => entry.queryId === query.id);
    const count = (state: Coverage['state']) =>
      entries.filter((entry) => entry.state === state).length;
    return {
      queryId: query.id,
      strategy: query.strategy,
      subqueries: entries.length,
      complete: count('complete'),
      partial: count('partial'),
      failed: count('failed'),
      pending: count('pending'),
      hits: entries.reduce((total, entry) => total + entry.fetchedHits, 0),
      uniqueCandidates: new Set(
        hits
          .filter((hit) => hit.queryId === query.id)
          .map((hit) => hit.candidate.id),
      ).size,
    };
  });
}

/** Resolves the package directory from this module, independent of the caller's working directory. */
function findPackageRoot(): string | null {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(directory, 'package.json'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function readGit(root: string | null): {
  revision: string | null;
  dirty: boolean | null;
} {
  if (!root) return { revision: null, dirty: null };
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  try {
    const revision = git(['rev-parse', 'HEAD']).trim();
    return {
      revision: revision || null,
      dirty: git(['status', '--porcelain']).trim().length > 0,
    };
  } catch {
    return { revision: null, dirty: null };
  }
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Streams rows to disk so the file size is not bounded by the maximum string length. */
export async function writeCsv(
  path: string,
  columns: string[],
  rows: Iterable<unknown[]>,
): Promise<void> {
  function* lines() {
    yield `${columns.map(csvField).join(',')}\n`;
    for (const row of rows) yield `${row.map(csvField).join(',')}\n`;
  }
  const iterator = lines();
  try {
    await pipeline(Readable.from(iterator), createWriteStream(path, 'utf8'));
  } finally {
    // Close nested generators and the SQLite cursor even if the destination fails.
    iterator.return();
  }
}

export function compareHits(left: StoredHit, right: StoredHit): number {
  return (
    left.candidate.id - right.candidate.id ||
    compareText(left.queryId, right.queryId) ||
    compareText(left.subqueryId, right.subqueryId) ||
    compareText(left.path ?? '', right.path ?? '')
  );
}

function csvField(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function environmentManifest() {
  const root = findPackageRoot();
  const git = readGit(root);
  const packageInfo = root
    ? readJsonFile<{ version?: string }>(join(root, 'package.json'))
    : null;
  const lockfilePath = root ? join(root, 'pnpm-lock.yaml') : null;
  const lockfile =
    lockfilePath && existsSync(lockfilePath)
      ? readFileSync(lockfilePath, 'utf8')
      : null;
  const lockfileVersion =
    lockfile?.match(/^lockfileVersion:\s*['"]?([^'"\s]+)/m)?.[1] ?? null;
  return {
    versions: {
      node: process.version,
      code: git.revision
        ? `git:${git.revision}`
        : packageInfo?.version
          ? `package:${packageInfo.version}`
          : null,
      lockfileVersion,
      lockfileSha256: lockfile ? sha256(lockfile) : null,
    },
    git: git.revision
      ? { available: true, revision: git.revision, dirty: git.dirty }
      : {
          available: false,
          revision: null,
          dirty: null,
          reason: 'Git metadata is unavailable',
        },
  };
}
