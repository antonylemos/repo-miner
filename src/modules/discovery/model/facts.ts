import type { Candidate } from './search.js';

export type AccountIdentity = {
  login: string | null;
  providerType: string | null;
};
export type CommitIdentity = {
  name: string | null;
  email: string | null;
  account: AccountIdentity | null;
};
export type RefObservation = {
  name: string;
  headSha: string;
  observedAt: string;
};
export type CommitFact = {
  repositoryId: number;
  sha: string;
  authoredDate: string;
  committedDate: string;
  author: CommitIdentity;
  committer: CommitIdentity;
  observedAt: string;
  /** References whose histories supplied this commit, for scoped branch evaluation. */
  refs?: RefObservation[];
};
export type RepositoryObservation = {
  id: string;
  repositoryId: number;
  source: 'search' | 'enrichment';
  observedAt: string;
  data: Record<string, unknown>;
  status: 'ok' | 'not_found' | 'failed';
};
export type FactRequest =
  | { kind: 'repository_metadata'; repositoryId: number; nodeId: string }
  | {
      kind: 'commit_history';
      repositoryId: number;
      since: string;
      until: string;
      branches: 'all' | 'default';
    };
export type ActivityCoverage = {
  request: Extract<FactRequest, { kind: 'commit_history' }>;
  refs: RefObservation[];
  pages: number;
  state: 'pending' | 'complete' | 'failed' | 'limited';
  reason: string | null;
  evidenceIds: string[];
};
export type CandidateFacts = {
  revision: number;
  candidate: Candidate;
  observations: RepositoryObservation[];
  commits: CommitFact[];
  coverage: ActivityCoverage[];
  inspectionUntil: string | null;
};
export type RuleEvaluation = {
  ruleId: string;
  evaluatorVersion: number;
  status: 'pass' | 'fail' | 'unknown';
  reason: string;
  evidenceIds: string[];
  requests: FactRequest[];
};
export type ProtocolEvaluation = {
  status: 'not_applied' | 'pass' | 'fail' | 'unknown';
  rules: RuleEvaluation[];
  requests: FactRequest[];
};
