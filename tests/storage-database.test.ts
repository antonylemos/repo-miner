import type { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { openConnection } from '../src/discovery/storage/connection.js';
import { createDatabaseAccess } from '../src/discovery/storage/database.js';
import { SCHEMA } from '../src/discovery/storage/schema.js';

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

test('should insert a row once and report whether it changed the database', () => {
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
