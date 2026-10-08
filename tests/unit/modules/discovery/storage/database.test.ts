import type { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openConnection } from '@/modules/discovery/storage/connection.js';
import { createDatabaseAccess } from '@/modules/discovery/storage/database.js';
import { SCHEMA } from '@/modules/discovery/storage/schema.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => {
    db.close();
  });
});

function setup() {
  const db = openConnection(':memory:', SCHEMA);
  databases.push(db);
  const access = createDatabaseAccess(db);
  access.run(
    'INSERT INTO candidates (repository_id, node_id, full_name, url, metadata_json, first_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    1,
    'R_1',
    'org/repo',
    'https://github.com/org/repo',
    '{}',
    'now',
  );

  return access;
}

it('should insert a row once and report whether it changed the database', () => {
  const access = setup();

  expect(
    access.insertIfAbsent('inspections', {
      repository_id: 1,
      until: '2026-10-06T12:00:00Z',
    }),
  ).toBe(true);
  expect(
    access.insertIfAbsent('inspections', {
      repository_id: 1,
      until: '2026-10-07T12:00:00Z',
    }),
  ).toBe(false);
  expect(access.all('SELECT * FROM inspections')).toEqual([
    { repository_id: 1, until: '2026-10-06T12:00:00Z' },
  ]);
});

it.each([
  [
    'observations of a repository',
    'SELECT data_json FROM repository_observations WHERE repository_id = ? ORDER BY rowid',
  ],
  [
    'pages of a task',
    'SELECT id FROM collection_pages WHERE task_id = ? ORDER BY id',
  ],
  [
    'tasks of a repository',
    "SELECT * FROM collection_tasks WHERE repository_id = ? AND state != 'cancelled' ORDER BY id",
  ],
  [
    'attempts of a repository in an invocation',
    "SELECT COUNT(*) AS n FROM collection_attempts WHERE repository_id = ? AND invocation_id = ? AND kind = 'activity'",
  ],
])('should read the %s through an index', (_name, sql) => {
  const access = setup();
  const plan = access
    .all(
      `EXPLAIN QUERY PLAN ${sql}`,
      ...sql
        .split('?')
        .slice(1)
        .map(() => 1),
    )
    .map((row) => String(row.detail));

  expect(plan.some((detail) => /^SEARCH .* USING .*INDEX/.test(detail))).toBe(
    true,
  );
  expect(plan.filter((detail) => detail.startsWith('SCAN'))).toEqual([]);
});
