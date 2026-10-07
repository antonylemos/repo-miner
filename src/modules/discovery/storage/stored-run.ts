import { DatabaseSync } from 'node:sqlite';
import { isPageSize } from '@/modules/discovery/collection/limits.js';
import type { CollectionLimits } from '@/modules/discovery/model/collection.js';
import type { StudyConfig } from '@/modules/discovery/model/study.js';
import { parseStudyConfig } from '@/modules/discovery/study/config.js';
import { inspectStore } from './store.js';

/**
 * Read-only views of an existing run, used before the writable store is opened.
 * They are separate operations so callers keep control of the order of their checks.
 */

/** Validates the schema and the stored configuration of the run in `path`. */
export function readStoredStudyConfig(path: string): StudyConfig {
  inspectStore(path);
  return readOnly(path, (db) => {
    const row = db.prepare('SELECT config_json FROM runs LIMIT 1').get();
    if (!row) throw new Error('No discovery run has been created');
    const config = JSON.parse(String(row.config_json)) as {
      catalog?: unknown;
      protocol?: unknown;
    };
    if (config.protocol === undefined)
      throw new Error('Invalid stored protocol configuration');
    return parseStudyConfig(config.catalog, config.protocol);
  });
}

/** Page sizes of the first invocation, which every later invocation must keep. */
export function readOriginalPageSizes(
  path: string,
): Pick<CollectionLimits, 'commitsPerPage' | 'branchesPerPage'> {
  return readOnly(path, (db) => {
    const row = db
      .prepare('SELECT limits_json FROM invocations ORDER BY rowid LIMIT 1')
      .get();
    if (!row) throw new Error('Missing original collection limits.');
    const stored = JSON.parse(
      String(row.limits_json),
    ) as Partial<CollectionLimits>;
    const { commitsPerPage, branchesPerPage } = stored;
    if (!isPageSize(commitsPerPage) || !isPageSize(branchesPerPage))
      throw new Error('Invalid stored pagination size.');
    return { commitsPerPage, branchesPerPage };
  });
}

function readOnly<T>(path: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return work(db);
  } finally {
    db.close();
  }
}
