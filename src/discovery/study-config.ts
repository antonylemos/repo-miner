import { parseQueries } from './catalog.js';
import { parseProtocol } from './eligibility/protocol.js';
import type { StudyConfig } from './eligibility/types.js';
import { expandQueries } from './expansion.js';
import type { Subquery } from './types.js';

export function parseStudyConfig(
  catalogInput: unknown,
  protocolInput?: unknown,
): StudyConfig {
  if (
    typeof catalogInput !== 'object' ||
    catalogInput === null ||
    Array.isArray(catalogInput)
  ) {
    throw new Error('Invalid catalog: expected an object with a queries array');
  }
  const input = catalogInput as Record<string, unknown>;
  return {
    catalog: { queries: parseQueries(input.queries) },
    protocol: parseProtocol(
      protocolInput === undefined ? { eligibility: [] } : protocolInput,
    ),
  };
}

export function prepareSearchPlan(
  config: StudyConfig,
  expansionDate: string,
): Subquery[] {
  const since = config.protocol.eligibility.reduce<string | null>(
    (latest, rule) =>
      rule.type === 'last_push' && (latest === null || rule.since > latest)
        ? rule.since
        : latest,
    null,
  );
  return expandQueries(
    config.catalog.queries,
    expansionDate,
    since === null ? null : `pushed:>=${since}`,
  );
}
