import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Catalog,
  Checkpoint,
  Coverage,
  Endpoint,
  EnrichmentResult,
  EnrichmentStatus,
  EnrichmentTarget,
  Partition,
  Query,
  Run,
  RunResult,
  SearchPage,
  StoredCandidate,
  StoredHit,
  Strategy,
  Subquery,
} from './types.js';

type StoredRow = Record<string, unknown>;

export type CreateRunInput = {
  catalog: Catalog;
  hash: string;
  startedAt: string;
  expansionDate: string;
  subqueries: Subquery[];
};

/** Synchronous persistence API for one auditable discovery run. */
export interface DiscoveryStore {
  /** Creates the run, its catalog, expanded subqueries and pending checkpoints. */
  createRun(input: CreateRunInput): Run;
  /** Reads the run metadata stored in this database. */
  getRun(): Run;
  /** Rebuilds the exact catalog stored when the run was created. */
  getCatalog(): Catalog;
  /** Reads subqueries in expansion order. */
  getSubqueries(): Subquery[];
  /** Reads the latest committed page checkpoint for a subquery. */
  getCheckpoint(subqueryId: string): Checkpoint;
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
  /** Marks the run as complete or partial. */
  finish(result: RunResult): void;
  /** Reads deduplicated repositories with their enrichment, if any. */
  readCandidates(): StoredCandidate[];
  /** Reads every retained discovery origin, including code paths and fetch times. */
  readHits(): StoredHit[];
  /** Aggregates page and checkpoint facts for every subquery. */
  readCoverage(): Coverage[];
  /** Aggregates page and checkpoint facts for one subquery. */
  readSubqueryCoverage(subqueryId: string): Coverage;
  /** Queues candidates whose search metadata lacks pushed_at; returns how many were added. */
  queueEnrichment(): number;
  /** Reads pending and failed enrichment targets. */
  readEnrichmentQueue(): EnrichmentTarget[];
  /** Stores one batch of enrichment results atomically. */
  saveEnrichments(results: EnrichmentResult[], fetchedAt: string): void;
  /** Counts enrichment rows by status. */
  readEnrichmentCounts(): Record<EnrichmentStatus, number>;
  /** Closes the SQLite connection. */
  close(): void;
}

const SCHEMA_VERSION = 2;
const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    catalog_hash TEXT NOT NULL,
    pushed_since TEXT NOT NULL,
    expansion_date TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'partial'))
  );
  CREATE TABLE IF NOT EXISTS queries (
    query_id TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL UNIQUE,
    strategy TEXT NOT NULL CHECK (strategy IN ('terminology', 'technology', 'broader')),
    endpoint TEXT NOT NULL CHECK (endpoint IN ('repositories', 'code')),
    q TEXT NOT NULL,
    rationale TEXT NOT NULL,
    partition_json TEXT
  );
  CREATE TABLE IF NOT EXISTS subqueries (
    subquery_id TEXT PRIMARY KEY,
    query_id TEXT NOT NULL REFERENCES queries(query_id),
    ordinal INTEGER NOT NULL UNIQUE,
    q_effective TEXT NOT NULL,
    partition_label TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pages (
    subquery_id TEXT NOT NULL REFERENCES subqueries(subquery_id),
    page INTEGER NOT NULL CHECK (page >= 1),
    total_count INTEGER NOT NULL CHECK (total_count >= 0),
    incomplete INTEGER NOT NULL CHECK (incomplete IN (0, 1)),
    fetched_at TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY (subquery_id, page)
  );
  CREATE TABLE IF NOT EXISTS candidates (
    repository_id INTEGER PRIMARY KEY,
    node_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    url TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hits (
    subquery_id TEXT NOT NULL REFERENCES subqueries(subquery_id),
    query_id TEXT NOT NULL REFERENCES queries(query_id),
    repository_id INTEGER NOT NULL REFERENCES candidates(repository_id),
    path TEXT NOT NULL,
    url TEXT NOT NULL,
    full_name TEXT NOT NULL,
    repository_url TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (subquery_id, repository_id, path)
  );
  CREATE TABLE IF NOT EXISTS checkpoints (
    subquery_id TEXT PRIMARY KEY REFERENCES subqueries(subquery_id),
    next_page INTEGER CHECK (next_page IS NULL OR next_page >= 1),
    state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'partial', 'failed')),
    reason TEXT
  );
  CREATE TABLE IF NOT EXISTS enrichments (
    repository_id INTEGER PRIMARY KEY REFERENCES candidates(repository_id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'not_found', 'failed')),
    fetched_at TEXT,
    data_json TEXT,
    reason TEXT
  );
`;

const SUBQUERY_SELECT = `
  SELECT s.subquery_id, s.query_id, q.strategy, q.endpoint, s.q_effective, s.partition_label
  FROM subqueries s JOIN queries q ON q.query_id = s.query_id`;

/** Opens a run database and creates its schema if needed. */
export function openStore(path: string): DiscoveryStore {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  assertSupportedSchema(database);
  database.exec(SCHEMA);
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  const transaction = (work: () => void): void => {
    database.exec('BEGIN IMMEDIATE');
    try {
      work();
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };

  const getRunRow = (): StoredRow => {
    const row = database.prepare('SELECT * FROM runs LIMIT 1').get() as
      | StoredRow
      | undefined;
    if (!row) throw new Error('No discovery run has been created');
    return row;
  };

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
    createRun({ catalog, hash, startedAt, expansionDate, subqueries }) {
      const existing = database.prepare('SELECT id FROM runs LIMIT 1').get();
      if (existing)
        throw new Error('This database already contains a discovery run');

      const run: Run = {
        id: randomUUID(),
        catalogHash: hash,
        pushedSince: catalog.filters.pushedSince,
        expansionDate,
        startedAt,
        endedAt: null,
        state: 'running',
      };
      transaction(() => {
        database
          .prepare(
            'INSERT INTO runs (id, catalog_hash, pushed_since, expansion_date, started_at, ended_at, state) VALUES (?, ?, ?, ?, ?, NULL, ?)',
          )
          .run(
            run.id,
            run.catalogHash,
            run.pushedSince,
            run.expansionDate,
            run.startedAt,
            run.state,
          );
        const insertQuery = database.prepare(
          'INSERT INTO queries (query_id, ordinal, strategy, endpoint, q, rationale, partition_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        );
        catalog.queries.forEach((query, ordinal) => {
          insertQuery.run(
            query.id,
            ordinal,
            query.strategy,
            query.endpoint,
            query.q,
            query.rationale,
            query.partition ? JSON.stringify(query.partition) : null,
          );
        });
        const insertSubquery = database.prepare(
          'INSERT INTO subqueries (subquery_id, query_id, ordinal, q_effective, partition_label) VALUES (?, ?, ?, ?, ?)',
        );
        const insertCheckpoint = database.prepare(
          "INSERT INTO checkpoints (subquery_id, next_page, state, reason) VALUES (?, 1, 'pending', NULL)",
        );
        subqueries.forEach((subquery, ordinal) => {
          insertSubquery.run(
            subquery.id,
            subquery.queryId,
            ordinal,
            subquery.q,
            subquery.partitionLabel,
          );
          insertCheckpoint.run(subquery.id);
        });
      });
      return run;
    },

    getRun() {
      const row = getRunRow();
      return {
        id: String(row.id),
        catalogHash: String(row.catalog_hash),
        pushedSince: String(row.pushed_since),
        expansionDate: String(row.expansion_date),
        startedAt: String(row.started_at),
        endedAt: row.ended_at === null ? null : String(row.ended_at),
        state: row.state as Run['state'],
      };
    },

    getCatalog() {
      const rows = database
        .prepare(
          'SELECT query_id, strategy, endpoint, q, rationale, partition_json FROM queries ORDER BY ordinal',
        )
        .all() as StoredRow[];
      return {
        version: 2,
        filters: { pushedSince: String(getRunRow().pushed_since) },
        queries: rows.map((row) => {
          const query: Query = {
            id: String(row.query_id),
            strategy: row.strategy as Strategy,
            endpoint: row.endpoint as Endpoint,
            q: String(row.q),
            rationale: String(row.rationale),
          };
          if (row.partition_json !== null) {
            query.partition = JSON.parse(
              String(row.partition_json),
            ) as Partition;
          }
          return query;
        }),
      };
    },

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

    finish(result) {
      const current = getRunRow();
      if (current.id !== result.run.id) {
        throw new Error('Run result does not match the database run');
      }
      database
        .prepare('UPDATE runs SET ended_at = ?, state = ? WHERE id = ?')
        .run(result.run.endedAt, result.run.state, result.run.id);
    },

    readCandidates() {
      const rows = database
        .prepare(
          `SELECT c.repository_id, c.node_id, c.full_name, c.url, c.metadata_json, c.first_seen_at,
                  e.status, e.fetched_at, e.data_json, e.reason
           FROM candidates c LEFT JOIN enrichments e ON e.repository_id = c.repository_id
           ORDER BY c.repository_id`,
        )
        .all() as StoredRow[];
      return rows.map((row) => ({
        id: Number(row.repository_id),
        nodeId: String(row.node_id),
        fullName: String(row.full_name),
        url: String(row.url),
        metadata: JSON.parse(String(row.metadata_json)) as Record<
          string,
          unknown
        >,
        firstSeenAt: String(row.first_seen_at),
        enrichment:
          row.status === null
            ? null
            : {
                status: row.status as EnrichmentStatus,
                fetchedAt:
                  row.fetched_at === null ? null : String(row.fetched_at),
                data:
                  row.data_json === null
                    ? null
                    : (JSON.parse(String(row.data_json)) as Record<
                        string,
                        unknown
                      >),
                reason: row.reason === null ? null : String(row.reason),
              },
      }));
    },

    readHits() {
      const rows = database
        .prepare(
          `SELECT h.query_id, h.subquery_id, q.strategy, q.endpoint, s.q_effective,
                  h.repository_id, c.node_id, h.path, h.url, h.full_name,
                  h.repository_url, h.metadata_json, h.fetched_at
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
          metadata: JSON.parse(String(row.metadata_json)) as Record<
            string,
            unknown
          >,
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

    queueEnrichment() {
      const result = database
        .prepare(
          `INSERT OR IGNORE INTO enrichments (repository_id, status)
           SELECT repository_id, 'pending' FROM candidates
           WHERE json_extract(metadata_json, '$.pushed_at') IS NULL`,
        )
        .run();
      return Number(result.changes);
    },

    readEnrichmentQueue() {
      const rows = database
        .prepare(
          `SELECT e.repository_id, c.node_id
           FROM enrichments e JOIN candidates c ON c.repository_id = e.repository_id
           WHERE e.status IN ('pending', 'failed')
           ORDER BY e.repository_id`,
        )
        .all() as StoredRow[];
      return rows.map((row) => ({
        repositoryId: Number(row.repository_id),
        nodeId: String(row.node_id),
      }));
    },

    saveEnrichments(results, fetchedAt) {
      transaction(() => {
        const update = database.prepare(
          'UPDATE enrichments SET status = ?, fetched_at = ?, data_json = ?, reason = ? WHERE repository_id = ?',
        );
        for (const result of results) {
          update.run(
            result.status,
            fetchedAt,
            result.data === null ? null : JSON.stringify(result.data),
            result.reason,
            result.repositoryId,
          );
        }
      });
    },

    readEnrichmentCounts() {
      const counts: Record<EnrichmentStatus, number> = {
        pending: 0,
        ok: 0,
        not_found: 0,
        failed: 0,
      };
      const rows = database
        .prepare(
          'SELECT status, COUNT(*) AS count FROM enrichments GROUP BY status',
        )
        .all() as StoredRow[];
      for (const row of rows) {
        counts[row.status as EnrichmentStatus] = Number(row.count);
      }
      return counts;
    },

    close() {
      database.close();
    },
  };
}

/** Refuses databases written by an older schema instead of migrating them silently. */
function assertSupportedSchema(database: DatabaseSync): void {
  const hasTables = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1")
    .get();
  const version = Number(
    (database.prepare('PRAGMA user_version').get() as StoredRow).user_version,
  );
  if (hasTables && version !== SCHEMA_VERSION) {
    database.close();
    throw new Error(
      `Unsupported discovery database schema (version ${version}); start a new run with the current catalog format`,
    );
  }
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
