import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export type Row = Record<string, unknown>;
export function inspectVersion(path: string): number {
  if (!existsSync(path)) throw new Error('Run database does not exist');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.prepare('PRAGMA integrity_check').get();
    return Number(
      (db.prepare('PRAGMA user_version').get() as Row).user_version,
    );
  } finally {
    db.close();
  }
}
export function openConnection(
  path: string,
  version: number,
  schema: string,
): DatabaseSync {
  const existing = path !== ':memory:' && existsSync(path);
  if (existing) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const v = Number(
        (db.prepare('PRAGMA user_version').get() as Row).user_version,
      );
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Row[];
      const expectedTables = [
        ...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g),
      ].map((match) => match[1]);
      if (
        tables.length &&
        (v !== version ||
          expectedTables.some((name) => !tables.some((t) => t.name === name)))
      )
        throw new Error(`Unsupported discovery database schema (version ${v})`);
      if (tables.length) {
        const reference = new DatabaseSync(':memory:');
        try {
          reference.exec(schema);
          for (const name of expectedTables) {
            const required = reference
              .prepare(`PRAGMA table_info(${name})`)
              .all() as Row[];
            const actual = db
              .prepare(`PRAGMA table_info(${name})`)
              .all() as Row[];
            if (
              required.some(
                (column) =>
                  !actual.some(
                    (c) =>
                      c.name === column.name &&
                      c.type === column.type &&
                      c.pk === column.pk &&
                      c.notnull === column.notnull &&
                      c.dflt_value === column.dflt_value,
                  ),
              )
            )
              throw new Error('Unrecognized discovery database table shape');
          }
        } finally {
          reference.close();
        }
      }
      const integrity = db.prepare('PRAGMA integrity_check').get() as Row;
      if (integrity.integrity_check !== 'ok')
        throw new Error('Corrupt discovery database');
    } finally {
      db.close();
    }
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec(schema);
    db.exec(`PRAGMA user_version = ${version}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function transaction(db: DatabaseSync, work: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export const SEARCH_SCHEMA = `
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
  CREATE INDEX IF NOT EXISTS hits_repository_observation
    ON hits (repository_id, fetched_at, subquery_id, path);
`;
