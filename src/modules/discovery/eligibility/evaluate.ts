import { ruleFor } from '@/modules/discovery/eligibility/registry.js';
import type {
  CandidateFacts,
  ProtocolEvaluation,
  RuleEvaluation,
} from '@/modules/discovery/model/facts.js';
import type { Protocol } from '@/modules/discovery/model/study.js';
export function evaluateProtocol(
  protocol: Protocol,
  facts: CandidateFacts,
): ProtocolEvaluation {
  if (protocol.eligibility.length === 0)
    return { status: 'not_applied', rules: [], requests: [] };
  const rules: RuleEvaluation[] = [];
  for (const rule of protocol.eligibility) {
    const evaluation = ruleFor(rule.type).evaluate(rule, facts);
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
