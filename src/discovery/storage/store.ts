import type {
  CollectionLimits,
  CollectionSummary,
  CollectionTask,
  CollectorStep,
} from '../collectors/types.js';
import type {
  CandidateFacts,
  FactRequest,
  ProtocolEvaluation,
  StudyConfig,
} from '../eligibility/types.js';
import type { HttpAttemptEvent } from '../http.js';
import type { Candidate, StoredHit, Subquery } from '../types.js';
import { createAttempts } from './attempts.js';
import { inspectDatabase, openConnection } from './connection.js';
import { createDatabaseAccess } from './database.js';
import { createFacts } from './facts.js';
import { createRuns } from './runs.js';
import { SCHEMA } from './schema.js';
import { createSearchData, type SearchStore } from './search-data.js';
import { createReadSnapshot } from './snapshot.js';
import { createSummary } from './summary.js';
import { createTasks } from './tasks.js';

export type Run = {
  id: string;
  catalog: StudyConfig['catalog'];
  protocol: StudyConfig['protocol'];
  catalogHash: string;
  protocolHash: string;
  evaluatorVersions: Record<string, number>;
  startedAt: string;
  expansionDate: string;
  endedAt: string | null;
  state: 'running' | 'complete' | 'partial';
  invocations: Array<{
    id: string;
    limits: CollectionLimits;
    startedAt: string;
  }>;
};
export type StoredCandidate = Candidate & {
  firstSeenAt: string;
  metadataObservedAt: string | null;
  evaluation: ProtocolEvaluation | null;
  factsRevision: number;
  evaluationRevision: number | null;
};
export interface DiscoveryStore extends SearchStore {
  createRun(input: {
    config: StudyConfig;
    subqueries: Subquery[];
    startedAt: string;
    expansionDate: string;
    limits: CollectionLimits;
  }): Run;
  getRun(): Run;
  getStudyConfig(): StudyConfig;
  iterateCandidates(): Iterable<StoredCandidate>;
  readHits(): StoredHit[];
  readCandidateFacts(repositoryId: number): CandidateFacts;
  beginInspection(repositoryId: number, until: string): void;
  syncTasks(repositoryId: number, requests: FactRequest[]): void;
  readTasks(): CollectionTask[];
  saveCollectionStep(task: CollectionTask, result: CollectorStep): void;
  reserveActivityAttempt(
    taskId: string,
    invocationId: string,
    limit: number,
  ): void;
  saveAttempt(taskId: string, event: HttpAttemptEvent): void;
  saveMetadataAttempt(
    invocationId: string,
    repositoryIds: number[],
    event: HttpAttemptEvent,
  ): void;
  recordCollectionDuration(
    taskId: string,
    invocationId: string,
    durationMs: number,
  ): void;
  saveEvaluation(
    repositoryId: number,
    evaluation: ProtocolEvaluation,
    factsRevision: number,
  ): void;
  readCollectionSummary(): CollectionSummary;
  startInvocation(limits: CollectionLimits, now: string): string;
  finish(input: { state: 'complete' | 'partial'; endedAt: string }): void;
  withReadSnapshot<T>(work: (store: DiscoveryStore) => Promise<T>): Promise<T>;
  close(): void;
}

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
