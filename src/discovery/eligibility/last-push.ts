import { isUsablePush } from '../scope.js';
import type { CandidateFacts, LastPushRule, RuleEvaluation } from './types.js';
export function evaluateLastPush(
  rule: LastPushRule,
  facts: CandidateFacts,
): RuleEvaluation {
  const result = {
    ruleId: rule.id,
    evaluatorVersion: 1,
    evidenceIds: [] as string[],
    requests: [] as RuleEvaluation['requests'],
  };
  const observations = facts.observations.filter(
    (o) => o.repositoryId === facts.candidate.id && o.status === 'ok',
  );
  const ordered = [...observations].sort(
    (a, b) =>
      Date.parse(a.observedAt) - Date.parse(b.observedAt) ||
      a.observedAt.localeCompare(b.observedAt) ||
      a.id.localeCompare(b.id),
  );
  const chosen =
    ordered.find(
      (o) => o.source === 'enrichment' && isUsablePush(o.data.pushedAt),
    ) ?? ordered.find((o) => isUsablePush(o.data.pushed_at));
  if (!chosen)
    return {
      ...result,
      status: 'unknown',
      reason: 'push_unavailable',
      requests: [
        {
          kind: 'repository_metadata',
          repositoryId: facts.candidate.id,
          nodeId: facts.candidate.nodeId,
        },
      ],
    };
  const push =
    chosen.source === 'enrichment' && isUsablePush(chosen.data.pushedAt)
      ? chosen.data.pushedAt
      : (chosen.data.pushed_at as string);
  const pass = Date.parse(push) >= Date.parse(`${rule.since}T00:00:00Z`);
  return {
    ...result,
    status: pass ? 'pass' : 'fail',
    reason: pass ? 'push_since_threshold' : 'push_before_threshold',
    evidenceIds: [chosen.id],
  };
}
