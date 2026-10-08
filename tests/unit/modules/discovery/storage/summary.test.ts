import type { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { openConnection } from '@/modules/discovery/storage/connection.js';
import { createDatabaseAccess } from '@/modules/discovery/storage/database.js';
import { SCHEMA } from '@/modules/discovery/storage/schema.js';
import { createSummary } from '@/modules/discovery/storage/summary.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => {
    db.close();
  });
});

/** Seeds candidates that each have one activity attempt and examined facts. */
function summaryWithCandidates(count: number) {
  const db = openConnection(':memory:', SCHEMA);
  databases.push(db);
  const access = createDatabaseAccess(db);
  access.run(
    'INSERT INTO invocations (id, limits_json, started_at) VALUES (?, ?, ?)',
    'invocation',
    '{}',
    'now',
  );
  for (let repositoryId = 1; repositoryId <= count; repositoryId += 1) {
    access.run(
      'INSERT INTO candidates (repository_id, node_id, full_name, url, metadata_json, first_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
      repositoryId,
      `R_${repositoryId}`,
      `org/repo-${repositoryId}`,
      'https://github.com/org/repo',
      '{}',
      'now',
    );
    access.run(
      'INSERT INTO collection_attempts (repository_id, invocation_id, kind) VALUES (?, ?, ?)',
      repositoryId,
      'invocation',
      'activity',
    );
    access.insertIfAbsent('collection_fact_invocations', {
      repository_id: repositoryId,
      invocation_id: 'invocation',
      kind: 'commit',
      fact_id: 'a',
    });
  }
  const summary = createSummary(access, {
    readTasks: () => [],
    iterateCandidates: () => [],
  });
  const prepare = vi.spyOn(db, 'prepare');
  const result = summary.readCollectionSummary();

  return { result, prepareCalls: prepare.mock.calls.length };
}

it('should not prepare more statements when the summary covers more candidates', () => {
  const one = summaryWithCandidates(1);
  const many = summaryWithCandidates(12);

  expect(many.result.perCandidate).toHaveLength(12);
  expect(many.result.perCandidate.every((c) => c.commitsExamined === 1)).toBe(
    true,
  );
  expect(many.prepareCalls).toBe(one.prepareCalls);
});
