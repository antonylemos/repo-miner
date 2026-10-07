import type {
  CollectionLimits,
  CollectionSummary,
  CollectionTask,
  CollectorStep,
  HttpAttemptEvent,
} from './collection.js';
import type {
  CandidateFacts,
  FactRequest,
  ProtocolEvaluation,
} from './facts.js';
import type {
  Candidate,
  Checkpoint,
  Coverage,
  SearchPage,
  StoredHit,
  Subquery,
} from './search.js';
import type { StudyConfig } from './study.js';

export interface SearchStore {
  /** Reads subqueries in expansion order. */
  getSubqueries(): Subquery[];
  /** Reads the latest committed page checkpoint for a subquery. */
  getCheckpoint(subqueryId: string): Checkpoint;
  /** Aggregates page and checkpoint facts for one subquery. */
  readSubqueryCoverage(subqueryId: string): Coverage;
  /** Saves a normalized result page and its checkpoint atomically. */
  savePage(
    subquery: Subquery,
    page: number,
    result: SearchPage,
    checkpoint: Checkpoint,
    fetchedAt: string,
  ): void;
  /** Marks a subquery state and stores a human-readable reason. */
  markSubquery(checkpoint: Checkpoint, reason: string): void;
  /** Aggregates page and checkpoint facts for every subquery. */
  readCoverage(): Coverage[];
}
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
