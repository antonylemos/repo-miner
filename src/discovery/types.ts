export type Strategy = 'terminology' | 'technology' | 'broader';
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
export type Catalog = {
  version: 2;
  filters: { pushedSince: string };
  queries: Query[];
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
export type Run = {
  id: string;
  catalogHash: string;
  pushedSince: string;
  expansionDate: string;
  startedAt: string;
  endedAt: string | null;
  state: 'running' | 'complete' | 'partial';
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
export type EnrichmentStatus = 'pending' | 'ok' | 'not_found' | 'failed';
export type EnrichmentSummary = {
  counts: Record<EnrichmentStatus, number>;
  required: { pending: number; failed: number };
  superseded: { pending: number; failed: number };
};
export type EnrichmentTarget = { repositoryId: number; nodeId: string };
export type EnrichmentResult = {
  repositoryId: number;
  status: Exclude<EnrichmentStatus, 'pending'>;
  data: Record<string, unknown> | null;
  reason: string | null;
};
export type Enrichment = {
  status: EnrichmentStatus;
  fetchedAt: string | null;
  data: Record<string, unknown> | null;
  reason: string | null;
};
export type StoredCandidate = Candidate & {
  firstSeenAt: string;
  metadataObservedAt: string | null;
  enrichment: Enrichment | null;
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
export type Scope = 'in_scope' | 'out_of_scope_temporal' | 'unknown';
export type RunResult = { run: Run; coverage: Coverage[] };
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
