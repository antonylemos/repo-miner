import { classifyAuthor } from '@/modules/discovery/eligibility/author.js';
import type {
  CandidateFacts,
  CommitFact,
  RuleEvaluation,
} from '@/modules/discovery/model/facts.js';
import type { RecentCommitRule } from '@/modules/discovery/model/study.js';
import type { RuleDefinition } from './definition.js';
export function commitEvidenceId(
  commit: Pick<CommitFact, 'repositoryId' | 'sha'>,
): string {
  return `commit:${commit.repositoryId}:${commit.sha}`;
}
export function evaluateRecentCommit(
  rule: RecentCommitRule,
  facts: CandidateFacts,
): RuleEvaluation {
  const result = {
    ruleId: rule.id,
    evaluatorVersion: recentCommitRule.version,
    evidenceIds: [] as string[],
    requests: [] as RuleEvaluation['requests'],
  };
  if (facts.inspectionUntil === null)
    return { ...result, status: 'unknown', reason: 'inspection_not_started' };
  const since = `${rule.since}T00:00:00Z`;
  const request = {
    kind: 'commit_history' as const,
    repositoryId: facts.candidate.id,
    since,
    until: facts.inspectionUntil,
    branches: rule.branches,
  };
  const coverage = facts.coverage.filter(
    (c) =>
      c.request.repositoryId === request.repositoryId &&
      c.request.branches === request.branches &&
      c.request.since === since &&
      c.request.until === request.until,
  );
  const metadata = facts.observations
    .filter((o) => o.repositoryId === facts.candidate.id && o.status === 'ok')
    .sort(
      (a, b) =>
        a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id),
    );
  const graph = metadata.find(
    (o) =>
      o.source === 'enrichment' &&
      typeof (o.data.defaultBranchRef as { name?: unknown } | undefined)
        ?.name === 'string',
  );
  const defaultName = graph
    ? (graph.data.defaultBranchRef as { name: string }).name
    : metadata.find((o) => typeof o.data.default_branch === 'string')?.data
        .default_branch;
  // Exact default-scope coverage can identify the observed default ref even without metadata.
  const defaultRefs = new Set(
    coverage.flatMap((c) => c.refs.map((r) => r.name)),
  );
  if (typeof defaultName === 'string') {
    defaultRefs.clear();
    defaultRefs.add(defaultName);
  }
  const commits = facts.commits.filter(
    (c) =>
      c.repositoryId === facts.candidate.id &&
      Date.parse(c.committedDate) >= Date.parse(since) &&
      Date.parse(c.committedDate) <= Date.parse(request.until) &&
      (rule.branches === 'all' || c.refs?.some((r) => defaultRefs.has(r.name))),
  );
  const positive = commits.find(
    (c) =>
      rule.authors === 'any' || classifyAuthor(c.author.account) === 'human',
  );
  if (positive)
    return {
      ...result,
      status: 'pass',
      reason: 'qualifying_commit',
      evidenceIds: [commitEvidenceId(positive)],
    };
  const complete = coverage.find((c) => c.state === 'complete');
  if (!complete)
    return {
      ...result,
      status: 'unknown',
      reason: 'activity_incomplete',
      requests: [request],
      evidenceIds: coverage.flatMap((c) => c.evidenceIds),
    };
  if (
    rule.authors === 'human' &&
    commits.some((c) => classifyAuthor(c.author.account) === 'unknown')
  )
    return {
      ...result,
      status: 'unknown',
      reason: 'author_indeterminate',
      evidenceIds: commits
        .filter((c) => classifyAuthor(c.author.account) === 'unknown')
        .map(commitEvidenceId),
    };
  return {
    ...result,
    status: 'fail',
    reason: 'no_qualifying_commit',
    evidenceIds: complete.evidenceIds,
  };
}

export const recentCommitRule: RuleDefinition<RecentCommitRule> = {
  type: 'recent_commit',
  version: 1,
  parse(value, base) {
    if (
      value.dateField !== 'committedDate' ||
      (value.branches !== 'all' && value.branches !== 'default') ||
      (value.authors !== 'human' && value.authors !== 'any')
    ) {
      throw new Error(
        `Invalid protocol rule "${base.id}": expected committedDate, branches all/default and authors human/any`,
      );
    }
    return {
      ...base,
      type: 'recent_commit',
      dateField: value.dateField,
      branches: value.branches,
      authors: value.authors,
    };
  },
  evaluate: evaluateRecentCommit,
};
