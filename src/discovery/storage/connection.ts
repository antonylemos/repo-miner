import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Row = Record<string, unknown>;

/** Databases written by an incompatible format are refused rather than migrated. */
export const UNSUPPORTED_DATABASE_MESSAGE =
  'Unsupported discovery database: it was created by an incompatible format. Create a new run with discover --output.';

/** Validates an existing database read-only; never writes to it. */
export function inspectDatabase(path: string, schema: string): void {
  if (!existsSync(path)) throw new Error('Run database does not exist');
  validateExisting(path, schema);
}

export function openConnection(path: string, schema: string): DatabaseSync {
  if (path !== ':memory:' && existsSync(path)) validateExisting(path, schema);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec(schema);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function validateExisting(path: string, schema: string): void {
  {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Row[];
      const expectedTables = [
        ...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g),
      ].map((match) => match[1]);
      if (expectedTables.some((name) => !tables.some((t) => t.name === name)))
        throw new Error(UNSUPPORTED_DATABASE_MESSAGE);
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
