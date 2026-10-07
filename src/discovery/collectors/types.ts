import type {
  CommitFact,
  FactRequest,
  RefObservation,
  RepositoryObservation,
} from '../eligibility/types.js';
export type BranchFact = RefObservation;
export type CollectionLimits = {
  branchesPerPage: number;
  commitsPerPage: number;
  maxActivityRequestsPerCandidate: number;
  maxActivityDurationMs: number | null;
};
export const DEFAULT_COLLECTION_LIMITS: CollectionLimits = {
  branchesPerPage: 100,
  commitsPerPage: 30,
  maxActivityRequestsPerCandidate: 20,
  maxActivityDurationMs: null,
};
export class BudgetExhaustedError extends Error {
  constructor(public readonly reason: 'request_budget' | 'duration_budget') {
    super(reason);
    this.name = 'BudgetExhaustedError';
  }
}
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
