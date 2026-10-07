import { evaluateLastPush } from './last-push.js';
import { evaluateRecentCommit } from './recent-commit.js';
import type {
  CandidateFacts,
  Protocol,
  ProtocolEvaluation,
  RuleEvaluation,
} from './types.js';
export const EVALUATOR_VERSIONS = {
  last_push: 1,
  recent_commit: 1,
  author: 1,
} as const;
export function evaluateProtocol(
  protocol: Protocol,
  facts: CandidateFacts,
): ProtocolEvaluation {
  if (protocol.eligibility.length === 0)
    return { status: 'not_applied', rules: [], requests: [] };
  const rules: RuleEvaluation[] = [];
  for (const rule of protocol.eligibility) {
    const evaluation =
      rule.type === 'last_push'
        ? evaluateLastPush(rule, facts)
        : evaluateRecentCommit(rule, facts);
    rules.push(evaluation);
    if (evaluation.status === 'fail')
      return { status: 'fail', rules, requests: [] };
  }
  const requests = [
    ...new Map(
      rules.flatMap((r) => r.requests).map((r) => [JSON.stringify(r), r]),
    ).values(),
  ];
  return {
    status: rules.some((r) => r.status === 'unknown') ? 'unknown' : 'pass',
    rules,
    requests,
  };
}
