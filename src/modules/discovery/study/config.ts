import { parseProtocol } from '@/modules/discovery/eligibility/protocol.js';
import { ruleFor } from '@/modules/discovery/eligibility/registry.js';
import type { Subquery } from '@/modules/discovery/model/search.js';
import type { StudyConfig } from '@/modules/discovery/model/study.js';
import { parseQueries } from './catalog.js';
import { expandQueries } from './expansion.js';

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
    (latest, rule) => {
      const candidate = ruleFor(rule.type).searchSince?.(rule) ?? null;
      return candidate !== null && (latest === null || candidate > latest)
        ? candidate
        : latest;
    },
    null,
  );
  return expandQueries(
    config.catalog.queries,
    expansionDate,
    since === null ? null : `pushed:>=${since}`,
  );
}
