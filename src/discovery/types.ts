export type Strategy = 'terminology' | 'technology' | 'broader';
export type Query = {
  id: string;
  strategy: Strategy;
  endpoint: 'repositories' | 'code';
  q: string;
};
export type Catalog = { version: 1; queries: Query[] };
export type Candidate = {
  id: number;
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
export type Checkpoint = {
  queryId: string;
  nextPage: number | null;
  state: 'pending' | 'complete' | 'partial' | 'failed';
};
export type Run = {
  id: string;
  catalogHash: string;
  startedAt: string;
  endedAt: string | null;
  state: 'running' | 'complete' | 'partial';
};
export type Coverage = {
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
export type RunResult = { run: Run; coverage: Coverage[] };
export type SearchClient = {
  search(query: Query, page: number, signal: AbortSignal): Promise<SearchPage>;
};
