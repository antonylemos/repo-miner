import { posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Checkpoint,
  Coverage,
  Endpoint,
  SearchPage,
  StoredHit,
  Strategy,
  Subquery,
} from '../types.js';

type StoredRow = Record<string, unknown>;

export interface SearchStore {
  /** Reads subqueries in expansion order. */
  getSubqueries(): Subquery[];
  /** Reads the latest committed page checkpoint for a subquery. */
  getCheckpoint(subqueryId: string): Checkpoint;
  /** Aggregates page and checkpoint facts for one subquery. */
  readSubqueryCoverage(subqueryId: string): Coverage;
  /** Saves a normalized result page and its checkpoint atomically. */
  savePage(
    subquery: Subquery,
    page: number,
    result: SearchPage,
    checkpoint: Checkpoint,
    fetchedAt: string,
  ): void;
  /** Marks a subquery state and stores a human-readable reason. */
  markSubquery(checkpoint: Checkpoint, reason: string): void;
  /** Aggregates page and checkpoint facts for every subquery. */
  readCoverage(): Coverage[];
}

const SUBQUERY_SELECT = `
  SELECT s.subquery_id, s.query_id, q.strategy, q.endpoint, s.q_effective, s.partition_label
  FROM subqueries s JOIN queries q ON q.query_id = s.query_id`;

export function createSearchData(
  database: DatabaseSync,
  transaction: (work: () => void) => void,
) {
  const assertSubqueryMatches = (subquery: Subquery): void => {
    const row = database
      .prepare(`${SUBQUERY_SELECT} WHERE s.subquery_id = ?`)
      .get(subquery.id) as StoredRow | undefined;
    if (!row || !sameSubquery(toSubquery(row), subquery)) {
      throw new Error(
        `Subquery "${subquery.id}" does not match the stored expansion`,
      );
    }
  };

  const readPageTotals = database.prepare(
    `SELECT COUNT(*) AS pages,
            COALESCE(SUM(json_array_length(result_json, '$.hits')), 0) AS hits,
            COALESCE(MAX(total_count), 0) AS total,
            COALESCE(MAX(incomplete), 0) AS incomplete
     FROM pages WHERE subquery_id = ?`,
  );
  const countCandidates = database.prepare(
    'SELECT COUNT(DISTINCT repository_id) AS count FROM hits WHERE subquery_id = ?',
  );
  const coverageFor = (row: StoredRow): Coverage => {
    const subqueryId = String(row.subquery_id);
    const totals = readPageTotals.get(subqueryId) as StoredRow;
    const reason = row.reason === null ? null : String(row.reason);
    return {
      subqueryId,
      queryId: String(row.query_id),
      fetchedPages: Number(totals.pages),
      fetchedHits: Number(totals.hits),
      uniqueCandidates: Number(
        (countCandidates.get(subqueryId) as StoredRow).count,
      ),
      totalReported: Number(totals.total),
      incomplete: Number(totals.incomplete) === 1,
      capped:
        reason !== null &&
        /\b(?:cap|capped|saturated|saturation)\b/i.test(reason),
      state: (row.state ?? 'pending') as Checkpoint['state'],
      reason,
    };
  };
  const COVERAGE_SELECT = `
    SELECT s.subquery_id, s.query_id, c.state, c.reason
    FROM subqueries s LEFT JOIN checkpoints c ON c.subquery_id = s.subquery_id`;

  return {
    getSubqueries() {
      const rows = database
        .prepare(`${SUBQUERY_SELECT} ORDER BY s.ordinal`)
        .all() as StoredRow[];
      return rows.map(toSubquery);
    },

    getCheckpoint(subqueryId) {
      const row = database
        .prepare(
          'SELECT subquery_id, next_page, state FROM checkpoints WHERE subquery_id = ?',
        )
        .get(subqueryId) as StoredRow | undefined;
      if (!row) throw new Error(`Unknown subquery checkpoint "${subqueryId}"`);
      return {
        subqueryId: String(row.subquery_id),
        nextPage: row.next_page === null ? null : Number(row.next_page),
        state: row.state as Checkpoint['state'],
      };
    },

    savePage(subquery, page, result, checkpoint, fetchedAt) {
      if (checkpoint.subqueryId !== subquery.id) {
        throw new Error(
          'Checkpoint subquery id does not match the result subquery',
        );
      }
      assertSubqueryMatches(subquery);

      transaction(() => {
        const committedPage = database
          .prepare('SELECT 1 FROM pages WHERE subquery_id = ? AND page = ?')
          .get(subquery.id, page);
        if (committedPage) return;

        const normalizedResult: SearchPage = {
          ...result,
          hits: result.hits.map((hit) => ({
            ...hit,
            path: normalizePath(hit.path) || null,
          })),
        };
        database
          .prepare(
            'INSERT INTO pages (subquery_id, page, total_count, incomplete, fetched_at, result_json) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            subquery.id,
            page,
            result.totalCount,
            result.incomplete ? 1 : 0,
            fetchedAt,
            JSON.stringify(normalizedResult),
          );

        const insertCandidate = database.prepare(
          'INSERT OR IGNORE INTO candidates (repository_id, node_id, full_name, url, metadata_json, first_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
        );
        const insertHit = database.prepare(
          'INSERT OR IGNORE INTO hits (subquery_id, query_id, repository_id, path, url, full_name, repository_url, metadata_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const hit of normalizedResult.hits) {
          const candidate = hit.candidate;
          const metadata = JSON.stringify(candidate.metadata);
          insertCandidate.run(
            candidate.id,
            candidate.nodeId,
            candidate.fullName,
            candidate.url,
            metadata,
            fetchedAt,
          );
          insertHit.run(
            subquery.id,
            subquery.queryId,
            candidate.id,
            hit.path ?? '',
            hit.url,
            candidate.fullName,
            candidate.url,
            metadata,
            fetchedAt,
          );
        }

        database
          .prepare(
            'INSERT INTO checkpoints (subquery_id, next_page, state, reason) VALUES (?, ?, ?, NULL) ON CONFLICT(subquery_id) DO UPDATE SET next_page = excluded.next_page, state = excluded.state, reason = NULL',
          )
          .run(checkpoint.subqueryId, checkpoint.nextPage, checkpoint.state);
      });
    },

    markSubquery(checkpoint, reason) {
      database
        .prepare(
          'INSERT INTO checkpoints (subquery_id, next_page, state, reason) VALUES (?, ?, ?, ?) ON CONFLICT(subquery_id) DO UPDATE SET next_page = excluded.next_page, state = excluded.state, reason = excluded.reason',
        )
        .run(
          checkpoint.subqueryId,
          checkpoint.nextPage,
          checkpoint.state,
          reason,
        );
    },

    readHits() {
      const rows = database
        .prepare(
          `SELECT h.query_id, h.subquery_id, q.strategy, q.endpoint, s.q_effective,
                  h.repository_id, c.node_id, h.path, h.url, h.full_name,
                  h.repository_url, h.fetched_at
           FROM hits h
           JOIN subqueries s ON s.subquery_id = h.subquery_id
           JOIN queries q ON q.query_id = h.query_id
           JOIN candidates c ON c.repository_id = h.repository_id
           ORDER BY h.query_id, h.subquery_id, h.repository_id, h.path`,
        )
        .all() as StoredRow[];
      return rows.map((row) => ({
        queryId: String(row.query_id),
        subqueryId: String(row.subquery_id),
        strategy: row.strategy as Strategy,
        endpoint: row.endpoint as Endpoint,
        qEffective: String(row.q_effective),
        fetchedAt: String(row.fetched_at),
        candidate: {
          id: Number(row.repository_id),
          nodeId: String(row.node_id),
          fullName: String(row.full_name),
          url: String(row.repository_url),
        },
        path: String(row.path) || null,
        url: String(row.url),
      }));
    },

    readCoverage() {
      const rows = database
        .prepare(`${COVERAGE_SELECT} ORDER BY s.ordinal`)
        .all() as StoredRow[];
      return rows.map(coverageFor);
    },

    readSubqueryCoverage(subqueryId) {
      const row = database
        .prepare(`${COVERAGE_SELECT} WHERE s.subquery_id = ?`)
        .get(subqueryId) as StoredRow | undefined;
      if (!row) throw new Error(`Unknown subquery "${subqueryId}"`);
      return coverageFor(row);
    },
  } satisfies SearchStore & { readHits(): StoredHit[] };
}

function toSubquery(row: StoredRow): Subquery {
  return {
    id: String(row.subquery_id),
    queryId: String(row.query_id),
    strategy: row.strategy as Strategy,
    endpoint: row.endpoint as Endpoint,
    q: String(row.q_effective),
    partitionLabel: String(row.partition_label),
  };
}

function sameSubquery(left: Subquery, right: Subquery): boolean {
  return (
    left.id === right.id &&
    left.queryId === right.queryId &&
    left.strategy === right.strategy &&
    left.endpoint === right.endpoint &&
    left.q === right.q &&
    left.partitionLabel === right.partitionLabel
  );
}

/** Normalizes a repository-relative path before using it as hit identity. */
function normalizePath(path: string | null): string {
  if (path === null || path.length === 0) return '';
  const normalized = posix.normalize(path.replaceAll('\\', '/'));
  return normalized === '.' ? '' : normalized.replace(/^\/+/, '');
}
