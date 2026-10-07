import type {
  CandidateFacts,
  RuleEvaluation,
} from '@/modules/discovery/model/facts.js';
import type { EligibilityRule } from '@/modules/discovery/model/study.js';

/** Everything the protocol needs to know about one kind of eligibility rule. */
export type RuleDefinition<R extends EligibilityRule> = {
  type: R['type'];
  /** Recorded with each run; bump it when the rule's evaluation changes. */
  version: number;
  /** Validates the fields specific to this rule; `base` is already validated. */
  parse(value: Record<string, unknown>, base: { id: string; since: string }): R;
  evaluate(rule: R, facts: CandidateFacts): RuleEvaluation;
  /** Date from which the search must be narrowed (`pushed:>=`), if the rule imposes one. */
  searchSince?(rule: R): string | null;
};
