import type { DiscoveryStore } from '@/modules/discovery/model/store.js';
import { createAttempts } from './attempts.js';
import { inspectDatabase, openConnection } from './connection.js';
import { createDatabaseAccess } from './database.js';
import { createFacts } from './facts.js';
import { createRuns } from './runs.js';
import { SCHEMA } from './schema.js';
import { createSearchData } from './search-data.js';
import { createReadSnapshot } from './snapshot.js';
import { createSummary } from './summary.js';
import { createTasks } from './tasks.js';

/** Validates an existing run database without opening it for writing. */
export function inspectStore(path: string): void {
  inspectDatabase(path, SCHEMA);
}

export function openStore(path: string): DiscoveryStore {
  const db = openConnection(path, SCHEMA);
  const access = createDatabaseAccess(db);
  const search = createSearchData(db, access.tx);
  const runs = createRuns(access);
  const facts = createFacts(access);
  const tasks = createTasks(access);
  const attempts = createAttempts(access);
  const summary = createSummary(access, {
    readTasks: tasks.readTasks,
    iterateCandidates: facts.iterateCandidates,
  });
  const snapshot = createReadSnapshot(db, () => store);

  const store: DiscoveryStore = {
    ...search,
    ...runs,
    ...facts,
    ...tasks,
    ...attempts,
    ...summary,
    ...snapshot,

    close() {
      db.close();
    },
  };

  return store;
}
