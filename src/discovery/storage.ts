import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isUsablePush } from './scope.js';
import {
  openConnection,
  SEARCH_SCHEMA,
  transaction as transact,
} from './storage/connection.js';
import {
  CANDIDATE_OBSERVATIONS_SELECT,
  createSearchData,
} from './storage/search-data.js';
import type {
  Catalog,
  Checkpoint,
  Coverage,
  Endpoint,
  EnrichmentResult,
  EnrichmentStatus,
  EnrichmentSummary,
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
  /** Reads one consistent view across asynchronous work on this connection. */
  withReadSnapshot<T>(
    work: (snapshot: DiscoveryStore) => Promise<T>,
  ): Promise<T>;
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
  /** Yields the same rows as readCandidates one at a time, for exports larger than memory. */
  iterateCandidates(): Iterable<StoredCandidate>;
  /** Reads every retained discovery origin, including code paths and fetch times. */
  readHits(): StoredHit[];
  /** Aggregates page and checkpoint facts for every subquery. */
  readCoverage(): Coverage[];
  /** Aggregates page and checkpoint facts for one subquery. */
  readSubqueryCoverage(subqueryId: string): Coverage;
  /** Queues candidates without a usable search push; returns how many were added. */
  queueEnrichment(): number;
  /** Reads pending and failed enrichment targets that still lack a usable search push. */
  readEnrichmentQueue(): EnrichmentTarget[];
  /** Stores one batch of enrichment results atomically. */
  saveEnrichments(results: EnrichmentResult[], fetchedAt: string): void;
  /** Counts enrichment rows by status. */
  readEnrichmentCounts(): Record<EnrichmentStatus, number>;
  /** Counts historical results and distinguishes required work from work superseded by search. */
  readEnrichmentSummary(): EnrichmentSummary;
  /** Closes the SQLite connection. */
  close(): void;
}

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
${SEARCH_SCHEMA}`;

/** Opens a run database and creates its schema if needed. */
export function openStore(path: string): DiscoveryStore {
  const database = openConnection(path, 2, SCHEMA);
  try {
    return initializeStore(database);
  } catch (error) {
    database.close();
    throw error;
  }
}

function initializeStore(database: DatabaseSync): DiscoveryStore {
  database.function('is_usable_push', { deterministic: true }, (value) =>
    isUsablePush(value) ? 1 : 0,
  );

  const transaction = (work: () => void): void => transact(database, work);

  const getRunRow = (): StoredRow => {
    const row = database.prepare('SELECT * FROM runs LIMIT 1').get() as
      | StoredRow
      | undefined;
    if (!row) throw new Error('No discovery run has been created');
    return row;
  };

  const search = createSearchData(database, transaction);
  let snapshotActive = false;
  const store: DiscoveryStore = {
    ...search,
    async withReadSnapshot(work) {
      if (snapshotActive)
        throw new Error(
          'A read snapshot is already active; nested snapshots are unsupported',
        );
      database.exec('BEGIN DEFERRED');
      snapshotActive = true;
      try {
        const result = await work(store);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      } finally {
        snapshotActive = false;
      }
    },
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
      return [...search.iterateCandidates()];
    },

    iterateCandidates: search.iterateCandidates,

    queueEnrichment() {
      const result = database
        .prepare(
          `INSERT OR IGNORE INTO enrichments (repository_id, status)
           SELECT repository_id, 'pending' FROM (${CANDIDATE_OBSERVATIONS_SELECT})
           WHERE is_usable_push(json_extract(metadata_json, '$.pushed_at')) = 0`,
        )
        .run();
      return Number(result.changes);
    },

    readEnrichmentQueue() {
      const rows = database
        .prepare(
          `SELECT repository_id, node_id FROM (${CANDIDATE_OBSERVATIONS_SELECT})
           WHERE status IN ('pending', 'failed')
             AND is_usable_push(json_extract(metadata_json, '$.pushed_at')) = 0
           ORDER BY repository_id`,
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

    readEnrichmentSummary() {
      const summary: EnrichmentSummary = {
        counts: { pending: 0, ok: 0, not_found: 0, failed: 0 },
        required: { pending: 0, failed: 0 },
        superseded: { pending: 0, failed: 0 },
      };
      const rows = database
        .prepare(
          `SELECT status, is_usable_push(json_extract(metadata_json, '$.pushed_at')) AS usable_push,
                  COUNT(*) AS count
           FROM (${CANDIDATE_OBSERVATIONS_SELECT})
           WHERE status IS NOT NULL
           GROUP BY status, usable_push`,
        )
        .all() as StoredRow[];
      for (const row of rows) {
        const status = row.status as EnrichmentStatus;
        const count = Number(row.count);
        summary.counts[status] += count;
        if (status === 'pending' || status === 'failed') {
          const relevance =
            Number(row.usable_push) === 1
              ? summary.superseded
              : summary.required;
          relevance[status] += count;
        }
      }
      return summary;
    },

    close() {
      database.close();
    },
  };
  return store;
}
