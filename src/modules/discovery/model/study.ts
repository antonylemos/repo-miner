import type { Query } from './search.js';

export type Catalog = { queries: Query[] };
export type LastPushRule = { id: string; type: 'last_push'; since: string };
export type RecentCommitRule = {
  id: string;
  type: 'recent_commit';
  since: string;
  dateField: 'committedDate';
  branches: 'all' | 'default';
  authors: 'human' | 'any';
};
export type EligibilityRule = LastPushRule | RecentCommitRule;
export type Protocol = { eligibility: EligibilityRule[] };
export type StudyConfig = { catalog: Catalog; protocol: Protocol };
