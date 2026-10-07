/** A free label chosen by the study; see `STRATEGY_PATTERN` in catalog.ts. */
export type Strategy = string;
export type Endpoint = 'repositories' | 'code';
export type Interval = 'month' | 'quarter' | 'year';
export type Partition =
  | { by: 'created'; from: string; interval: Interval }
  | { by: 'size'; bounds: number[] };
export type Query = {
  id: string;
  strategy: Strategy;
  endpoint: Endpoint;
  q: string;
  rationale: string;
  partition?: Partition;
};
/** One concrete GitHub search derived from a catalog query; `q` is the effective search text. */
export type Subquery = {
  id: string;
  queryId: string;
  strategy: Strategy;
  endpoint: Endpoint;
  q: string;
  partitionLabel: string;
};
export type Candidate = {
  id: number;
  nodeId: string;
  fullName: string;
  url: string;
  metadata: Record<string, unknown>;
};
export type SearchHit = {
  candidate: Candidate;
  path: string | null;
  url: string;
};
export type SearchPage = {
  totalCount: number;
  incomplete: boolean;
  hits: SearchHit[];
  hasNext: boolean;
};
export type SearchCount = { totalCount: number; incomplete: boolean };
export type Checkpoint = {
  subqueryId: string;
  nextPage: number | null;
  state: 'pending' | 'complete' | 'partial' | 'failed';
};
export type Coverage = {
  subqueryId: string;
  queryId: string;
  fetchedPages: number;
  fetchedHits: number;
  uniqueCandidates: number;
  totalReported: number;
  incomplete: boolean;
  capped: boolean;
  state: Checkpoint['state'];
  reason: string | null;
};
export type EnrichmentTarget = { repositoryId: number; nodeId: string };
export type EnrichmentResult = {
  repositoryId: number;
  status: 'ok' | 'not_found' | 'failed';
  data: Record<string, unknown> | null;
  reason: string | null;
};
/** A retained origin; repository metadata lives on the candidate, not on each hit. */
export type StoredHit = Omit<SearchHit, 'candidate'> & {
  candidate: Omit<Candidate, 'metadata'>;
  queryId: string;
  subqueryId: string;
  strategy: Strategy;
  endpoint: Endpoint;
  qEffective: string;
  fetchedAt: string;
};
export type SearchClient = {
  search(
    subquery: Subquery,
    page: number,
    signal: AbortSignal,
  ): Promise<SearchPage>;
};
export type CountClient = {
  count(subquery: Subquery, signal: AbortSignal): Promise<SearchCount>;
};
export type EnrichmentClient = {
  fetchRepositories(
    targets: EnrichmentTarget[],
    signal: AbortSignal,
  ): Promise<EnrichmentResult[]>;
};
