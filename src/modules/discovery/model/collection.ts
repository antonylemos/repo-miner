import type {
  CommitFact,
  FactRequest,
  RefObservation,
  RepositoryObservation,
} from './facts.js';
import type { EnrichmentTarget } from './search.js';

export type ActivityTarget = EnrichmentTarget & { fullName: string };
export type ObservedPage<T> = {
  items: T[];
  hasNext: boolean;
  observedAt: string;
  requestUrl: string;
  raw: unknown;
};
export type BranchResponse = {
  ref: BranchFact;
  observedAt: string;
  requestUrl: string;
  raw: unknown;
};
export type ActivityHooks = {
  beforeAttempt?: () => void;
  onAttemptFinished?: (event: HttpAttemptEvent) => void;
};
export type ActivityClient = {
  readBranch(
    target: ActivityTarget,
    branch: string,
    signal: AbortSignal,
  ): Promise<BranchResponse>;
  listBranches(
    target: ActivityTarget,
    page: number,
    signal: AbortSignal,
  ): Promise<ObservedPage<BranchFact>>;
  listCommits(
    target: ActivityTarget,
    headSha: string,
    interval: { since: string; until: string },
    page: number,
    signal: AbortSignal,
  ): Promise<ObservedPage<CommitFact>>;
};
export type BranchFact = RefObservation;
export type CollectionLimits = {
  branchesPerPage: number;
  commitsPerPage: number;
  maxActivityRequestsPerCandidate: number;
  maxActivityDurationMs: number | null;
};
export type RefCheckpoint = {
  ref: BranchFact;
  nextPage: number | null;
  complete: boolean;
};
export type ActivityCheckpoint = {
  defaultRef: RefCheckpoint | null;
  defaultResolved: boolean;
  nextBranchesPage: number | null;
  refsComplete: boolean;
  otherRefs: RefCheckpoint[];
};
export type CollectionTask = {
  id: string;
  repositoryId: number;
  request: FactRequest;
  state: 'pending' | 'complete' | 'failed' | 'limited' | 'cancelled';
  checkpoint: ActivityCheckpoint | null;
  reason: string | null;
};
export type CollectorStep = {
  repositoryObservations: RepositoryObservation[];
  refs: BranchFact[];
  commits: CommitFact[];
  response: { requestUrl: string; observedAt: string; raw: unknown } | null;
  checkpoint: ActivityCheckpoint | null;
  state: 'pending' | 'complete' | 'failed' | 'limited';
  reason: string | null;
};
export type RequestMetrics = {
  attempts: number;
  retries: number;
  responseBytes: number | null;
  waitMs: number;
  activeDurationMs: number;
  rateLimitCost: number | null;
};
export type CollectionSummary = {
  activity: RequestMetrics;
  metadata: RequestMetrics;
  required: {
    pending: number;
    failed: number;
    limited: number;
    pendingEvaluations: number;
  };
  unknownReasons: Record<string, number>;
  perCandidate: Array<{
    repositoryId: number;
    invocationId: string;
    activity: RequestMetrics;
    commitsExamined: number;
    refsExamined: number;
  }>;
  invocations: Array<{
    id: string;
    limits: CollectionLimits;
    activity: RequestMetrics;
    metadata: RequestMetrics;
  }>;
};
export type HttpAttemptEvent = {
  attempt: number;
  startedAt: number;
  finishedAt: number;
  waitMs: number;
  status: number | null;
  responseBytes: number | null;
  rateLimitResource: string | null;
  rateLimitUsed: number | null;
  error: string | null;
};
