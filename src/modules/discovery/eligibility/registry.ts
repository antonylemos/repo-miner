import type { EligibilityRule } from '@/modules/discovery/model/study.js';
import { AUTHOR_VERSION } from './author.js';
import type { RuleDefinition } from './rules/definition.js';
import { lastPushRule } from './rules/last-push.js';
import { recentCommitRule } from './rules/recent-commit.js';

type RuleType = EligibilityRule['type'];
type Definitions = {
  [T in RuleType]: RuleDefinition<Extract<EligibilityRule, { type: T }>>;
};

// Declaring every member of the `EligibilityRule` union here is enforced by the compiler.
const DEFINITIONS: Definitions = {
  last_push: lastPushRule,
  recent_commit: recentCommitRule,
};
const BY_TYPE = new Map<string, RuleDefinition<EligibilityRule>>(
  Object.values(DEFINITIONS).map((definition) => [
    definition.type,
    // Each definition only ever receives rules of its own type; see `ruleFor`.
    definition as RuleDefinition<EligibilityRule>,
  ]),
);

/** Rule versions in registration order, then the components that are not rules. */
export const EVALUATOR_VERSIONS: Readonly<Record<string, number>> = {
  ...Object.fromEntries(
    Object.values(DEFINITIONS).map((definition) => [
      definition.type,
      definition.version,
    ]),
  ),
  author: AUTHOR_VERSION,
};

export function ruleFor(type: RuleType): RuleDefinition<EligibilityRule>;
export function ruleFor(
  type: unknown,
): RuleDefinition<EligibilityRule> | undefined;
export function ruleFor(type: unknown) {
  return typeof type === 'string' ? BY_TYPE.get(type) : undefined;
}
