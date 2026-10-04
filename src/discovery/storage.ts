import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Candidate,
  Catalog,
  Checkpoint,
  Coverage,
  Query,
  Run,
  RunResult,
  SearchHit,
  SearchPage,
  Strategy,
} from './types.js';

type StoredRow = Record<string, unknown>;

/** Synchronous persistence API for one auditable discovery run. */
export interface DiscoveryStore {
  /** Creates the run and its initial pending query checkpoints. */
  createRun(catalog: Catalog, hash: string, startedAt: string): Run;
  /** Reads the run metadata stored in this database. */
  getRun(): Run;
  /** Reads the exact query catalog stored when the run was created. */
  getCatalog(): Catalog;
  /** Reads the latest committed page checkpoint for a query. */
  getCheckpoint(queryId: string): Checkpoint;
  /** Saves a normalized result page and its checkpoint atomically. */
  savePage(
    query: Query,
    page: number,
    result: SearchPage,
    checkpoint: Checkpoint,
    fetchedAt: string,
  ): void;
  /** Marks a query state and stores a human-readable reason. */
  markQuery(checkpoint: Checkpoint, reason: string): void;
  /** Marks the run as complete or partial. */
  finish(result: RunResult): void;
  /** Reads deduplicated repositories by GitHub's stable numeric id. */
  readCandidates(): Candidate[];
  /** Reads every retained discovery origin, including code paths. */
  readHits(): Array<SearchHit & { queryId: string; strategy: Strategy }>;
  /** Aggregates page and checkpoint facts for the run report. */
  readCoverage(): Coverage[];
  /** Closes the SQLite connection. */
  close(): void;
}

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    catalog_hash TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'partial'))
  );
  CREATE TABLE IF NOT EXISTS queries (
    query_id TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL UNIQUE,
    strategy TEXT NOT NULL CHECK (strategy IN ('terminology', 'technology', 'broader')),
    endpoint TEXT NOT NULL CHECK (endpoint IN ('repositories', 'code')),
    q TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pages (
    query_id TEXT NOT NULL REFERENCES queries(query_id),
    page INTEGER NOT NULL CHECK (page >= 1),
    total_count INTEGER NOT NULL CHECK (total_count >= 0),
    incomplete INTEGER NOT NULL CHECK (incomplete IN (0, 1)),
    fetched_at TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY (query_id, page)
  );
  CREATE TABLE IF NOT EXISTS candidates (
    repository_id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL,
    url TEXT NOT NULL,
    metadata_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hits (
    query_id TEXT NOT NULL REFERENCES queries(query_id),
    repository_id INTEGER NOT NULL REFERENCES candidates(repository_id),
    path TEXT NOT NULL,
    url TEXT NOT NULL,
    full_name TEXT NOT NULL,
    repository_url TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    PRIMARY KEY (query_id, repository_id, path)
  );
  CREATE TABLE IF NOT EXISTS checkpoints (
    query_id TEXT PRIMARY KEY REFERENCES queries(query_id),
    next_page INTEGER CHECK (next_page IS NULL OR next_page >= 1),
    state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'partial', 'failed')),
    reason TEXT
  );
`;

/** Opens a run database and creates its schema if needed. */
export function openStore(path: string): DiscoveryStore {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(SCHEMA);

  const getRunRow = (): StoredRow => {
    const row = database.prepare('SELECT * FROM runs LIMIT 1').get() as
      | StoredRow
      | undefined;
    if (!row) throw new Error('No discovery run has been created');
    return row;
  };

  const assertQueryMatchesCatalog = (query: Query): void => {
    const row = database
      .prepare('SELECT strategy, endpoint, q FROM queries WHERE query_id = ?')
      .get(query.id) as StoredRow | undefined;
    if (
      !row ||
      row.strategy !== query.strategy ||
      row.endpoint !== query.endpoint ||
      row.q !== query.q
    ) {
      throw new Error(`Query "${query.id}" does not match the stored catalog`);
    }
  };

  return {
    createRun(catalog, hash, startedAt) {
      const existing = database.prepare('SELECT id FROM runs LIMIT 1').get();
      if (existing)
        throw new Error('This database already contains a discovery run');

      const run: Run = {
        id: randomUUID(),
        catalogHash: hash,
        startedAt,
        endedAt: null,
        state: 'running',
      };
      database.exec('BEGIN IMMEDIATE');
      try {
        database
          .prepare(
            'INSERT INTO runs (id, catalog_hash, started_at, ended_at, state) VALUES (?, ?, ?, NULL, ?)',
          )
          .run(run.id, run.catalogHash, run.startedAt, run.state);
        const insertQuery = database.prepare(
          'INSERT INTO queries (query_id, ordinal, strategy, endpoint, q) VALUES (?, ?, ?, ?, ?)',
        );
        const insertCheckpoint = database.prepare(
          "INSERT INTO checkpoints (query_id, next_page, state, reason) VALUES (?, 1, 'pending', NULL)",
        );
        catalog.queries.forEach((query, ordinal) => {
          insertQuery.run(
            query.id,
            ordinal,
            query.strategy,
            query.endpoint,
            query.q,
          );
          insertCheckpoint.run(query.id);
        });
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return run;
    },

    getRun() {
      const row = getRunRow();
      return {
        id: String(row.id),
        catalogHash: String(row.catalog_hash),
        startedAt: String(row.started_at),
        endedAt: row.ended_at === null ? null : String(row.ended_at),
        state: row.state as Run['state'],
      };
    },

    getCatalog() {
      const rows = database
        .prepare(
          'SELECT query_id, strategy, endpoint, q FROM queries ORDER BY ordinal',
        )
        .all() as StoredRow[];
      return {
        version: 1,
        queries: rows.map((row) => ({
          id: String(row.query_id),
          strategy: row.strategy as Strategy,
          endpoint: row.endpoint as Query['endpoint'],
          q: String(row.q),
        })),
      };
    },

    getCheckpoint(queryId) {
      const row = database
        .prepare(
          'SELECT query_id, next_page, state FROM checkpoints WHERE query_id = ?',
        )
        .get(queryId) as StoredRow | undefined;
      if (!row) throw new Error(`Unknown query checkpoint "${queryId}"`);
      return {
        queryId: String(row.query_id),
        nextPage: row.next_page === null ? null : Number(row.next_page),
        state: row.state as Checkpoint['state'],
      };
    },

    savePage(query, page, result, checkpoint, fetchedAt) {
      if (checkpoint.queryId !== query.id) {
        throw new Error('Checkpoint query id does not match the result query');
      }
      assertQueryMatchesCatalog(query);

      database.exec('BEGIN IMMEDIATE');
      try {
        const committedPage = database
          .prepare('SELECT 1 FROM pages WHERE query_id = ? AND page = ?')
          .get(query.id, page);
        if (committedPage) {
          database.exec('COMMIT');
          return;
        }

        const normalizedResult: SearchPage = {
          ...result,
          hits: result.hits.map((hit) => ({
            ...hit,
            path: normalizePath(hit.path) || null,
          })),
        };
        database
          .prepare(
            'INSERT OR IGNORE INTO pages (query_id, page, total_count, incomplete, fetched_at, result_json) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            query.id,
            page,
            result.totalCount,
            result.incomplete ? 1 : 0,
            fetchedAt,
            JSON.stringify(normalizedResult),
          );

        const insertCandidate = database.prepare(
          'INSERT OR IGNORE INTO candidates (repository_id, full_name, url, metadata_json) VALUES (?, ?, ?, ?)',
        );
        const insertHit = database.prepare(
          'INSERT OR IGNORE INTO hits (query_id, repository_id, path, url, full_name, repository_url, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        );
        for (const hit of normalizedResult.hits) {
          const candidate = hit.candidate;
          const metadata = JSON.stringify(candidate.metadata);
          insertCandidate.run(
            candidate.id,
            candidate.fullName,
            candidate.url,
            metadata,
          );
          insertHit.run(
            query.id,
            candidate.id,
            hit.path ?? '',
            hit.url,
            candidate.fullName,
            candidate.url,
            metadata,
          );
        }

        database
          .prepare(
            'INSERT INTO checkpoints (query_id, next_page, state, reason) VALUES (?, ?, ?, NULL) ON CONFLICT(query_id) DO UPDATE SET next_page = excluded.next_page, state = excluded.state, reason = NULL',
          )
          .run(checkpoint.queryId, checkpoint.nextPage, checkpoint.state);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },

    markQuery(checkpoint, reason) {
      database
        .prepare(
          'INSERT INTO checkpoints (query_id, next_page, state, reason) VALUES (?, ?, ?, ?) ON CONFLICT(query_id) DO UPDATE SET next_page = excluded.next_page, state = excluded.state, reason = excluded.reason',
        )
        .run(checkpoint.queryId, checkpoint.nextPage, checkpoint.state, reason);
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
          'SELECT repository_id, full_name, url, metadata_json FROM candidates ORDER BY repository_id',
        )
        .all() as StoredRow[];
      return rows.map((row) => ({
        id: Number(row.repository_id),
        fullName: String(row.full_name),
        url: String(row.url),
        metadata: JSON.parse(String(row.metadata_json)) as Record<
          string,
          unknown
        >,
      }));
    },

    readHits() {
      const rows = database
        .prepare(
          `SELECT hits.query_id, queries.strategy, hits.repository_id,
                  hits.path, hits.url, hits.full_name, hits.repository_url,
                  hits.metadata_json
           FROM hits JOIN queries ON queries.query_id = hits.query_id
           ORDER BY hits.query_id, hits.repository_id, hits.path`,
        )
        .all() as StoredRow[];
      return rows.map((row) => ({
        queryId: String(row.query_id),
        strategy: row.strategy as Strategy,
        candidate: {
          id: Number(row.repository_id),
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
      const queryRows = database
        .prepare(
          `SELECT queries.query_id, checkpoints.next_page, checkpoints.state,
                  checkpoints.reason
           FROM queries LEFT JOIN checkpoints ON checkpoints.query_id = queries.query_id
           ORDER BY queries.ordinal`,
        )
        .all() as StoredRow[];
      const readPages = database.prepare(
        'SELECT total_count, incomplete, result_json FROM pages WHERE query_id = ?',
      );
      const countCandidates = database.prepare(
        'SELECT COUNT(DISTINCT repository_id) AS count FROM hits WHERE query_id = ?',
      );

      return queryRows.map((row) => {
        const queryId = String(row.query_id);
        const pages = readPages.all(queryId) as StoredRow[];
        const reason = row.reason === null ? null : String(row.reason);
        return {
          queryId,
          fetchedPages: pages.length,
          fetchedHits: pages.reduce((count, page) => {
            const saved = JSON.parse(String(page.result_json)) as SearchPage;
            return count + saved.hits.length;
          }, 0),
          uniqueCandidates: Number(
            (countCandidates.get(queryId) as StoredRow).count,
          ),
          totalReported: pages.reduce(
            (total, page) => Math.max(total, Number(page.total_count)),
            0,
          ),
          incomplete: pages.some((page) => Number(page.incomplete) === 1),
          capped:
            reason !== null &&
            /\b(?:cap|capped|saturated|saturation)\b/i.test(reason),
          state: (row.state ?? 'pending') as Checkpoint['state'],
          reason,
        };
      });
    },

    close() {
      database.close();
    },
  };
}

/** Normalizes a repository-relative path before using it as hit identity. */
function normalizePath(path: string | null): string {
  if (path === null || path.length === 0) return '';
  const normalized = posix.normalize(path.replaceAll('\\', '/'));
  return normalized === '.' ? '' : normalized.replace(/^\/+/, '');
}
