import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../catalog.js';
import type { CollectionTask } from '../collectors/types.js';
import type { RepositoryObservation } from '../eligibility/types.js';
import { type Row, transaction } from './connection.js';

export type SqlValue = string | number | null;

/** Tables written with INSERT OR IGNORE, mapped to the columns each one accepts. */
type InsertableColumns = {
  repository_observations: 'id' | 'repository_id' | 'data_json';
  inspections: 'repository_id' | 'until';
  activity_refs: 'repository_id' | 'id' | 'data_json';
  activity_commits: 'repository_id' | 'sha' | 'data_json';
  activity_commit_refs: 'repository_id' | 'ref_id' | 'sha';
  task_refs: 'task_id' | 'repository_id' | 'ref_id';
  collection_pages: 'id' | 'task_id' | 'data_json';
  collection_fact_invocations:
    | 'repository_id'
    | 'invocation_id'
    | 'kind'
    | 'fact_id';
};

export type InsertableTable = keyof InsertableColumns;

/** Canonical SHA-256 of a JSON-serializable value. */
export function hashOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

export type DatabaseAccess = ReturnType<typeof createDatabaseAccess>;

/** Query, transaction and lookup helpers shared by every store module. */
export function createDatabaseAccess(db: DatabaseSync) {
  const get = (sql: string, ...values: SqlValue[]) =>
    db.prepare(sql).get(...values) as Row | undefined;

  const all = (sql: string, ...values: SqlValue[]) =>
    db.prepare(sql).all(...values) as Row[];

  const run = (sql: string, ...values: SqlValue[]) =>
    db.prepare(sql).run(...values);

  const tx = (work: () => void) => transaction(db, work);

  /**
   * Inserts a row unless its key already exists and reports whether it was
   * inserted. Table and column names come from code, never from input.
   */
  const insertIfAbsent = <Table extends InsertableTable>(
    table: Table,
    row: Record<InsertableColumns[Table], SqlValue>,
  ): boolean => {
    const columns = Object.keys(row);
    const placeholders = columns.map(() => '?').join(', ');
    const result = run(
      `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
      ...(Object.values(row) as SqlValue[]),
    );

    return Number(result.changes) > 0;
  };

  const saveObservation = (observation: RepositoryObservation): boolean =>
    insertIfAbsent('repository_observations', {
      id: observation.id,
      repository_id: observation.repositoryId,
      data_json: canonicalJson(observation),
    });

  const candidateRow = (repositoryId: number): Row => {
    const row = get(
      'SELECT * FROM candidates WHERE repository_id = ?',
      repositoryId,
    );
    if (!row) throw new Error(`Unknown repository ${repositoryId}`);

    return row;
  };

  const taskRow = (taskId: string): Row => {
    const row = get('SELECT * FROM collection_tasks WHERE id = ?', taskId);
    if (!row) throw new Error('Unknown collection task');

    return row;
  };

  const taskFromRow = (row: Row): CollectionTask => ({
    id: String(row.id),
    repositoryId: Number(row.repository_id),
    request: parseJson(row.request_json),
    state: row.state as CollectionTask['state'],
    checkpoint:
      row.checkpoint_json === null ? null : parseJson(row.checkpoint_json),
    reason: row.reason === null ? null : String(row.reason),
  });

  const bumpFactsRevision = (repositoryId: number): void => {
    run(
      'UPDATE candidates SET facts_revision = facts_revision + 1 WHERE repository_id = ?',
      repositoryId,
    );
  };

  return {
    db,
    get,
    all,
    run,
    tx,
    insertIfAbsent,
    saveObservation,
    candidateRow,
    taskRow,
    taskFromRow,
    bumpFactsRevision,
  };
}
