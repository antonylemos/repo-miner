import type {
  CandidateFacts,
  RuleEvaluation,
} from '@/modules/discovery/model/facts.js';
import type { LastPushRule } from '@/modules/discovery/model/study.js';
import type { RuleDefinition } from './definition.js';
/** A push must be a nonempty string representing a finite timestamp. */
export function isUsablePush(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

export function evaluateLastPush(
  rule: LastPushRule,
  facts: CandidateFacts,
): RuleEvaluation {
  const result = {
    ruleId: rule.id,
    evaluatorVersion: lastPushRule.version,
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

export const lastPushRule: RuleDefinition<LastPushRule> = {
  type: 'last_push',
  version: 1,
  parse: (_value, base) => ({ ...base, type: 'last_push' }),
  evaluate: evaluateLastPush,
  searchSince: (rule) => rule.since,
};
