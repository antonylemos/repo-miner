import { parseCatalog, parseQueries } from './catalog.js';
import { parseProtocol } from './eligibility/protocol.js';
import type { StudyConfig } from './eligibility/types.js';
import { expandCatalog, expandQueries } from './expansion.js';
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
    throw new Error('Invalid catalog: expected version 2 or version 3');
  }
  const input = catalogInput as Record<string, unknown>;
  if (input.version === 2) {
    if (protocolInput !== undefined)
      throw new Error(
        'A separate protocol requires converting the catalog to version 3',
      );
    return { kind: 'legacy', catalog: parseCatalog(input) };
  }
  if (input.version !== 3)
    throw new Error('Invalid catalog: expected version 2 or version 3');
  if ('filters' in input)
    throw new Error(
      'Catalog version 3 filters must be moved to a separate protocol',
    );
  return {
    kind: 'protocol',
    catalog: { version: 3, queries: parseQueries(input.queries) },
    protocol: parseProtocol(
      protocolInput === undefined
        ? { version: 1, eligibility: [] }
        : protocolInput,
    ),
  };
}

export function prepareSearchPlan(
  config: StudyConfig,
  expansionDate: string,
): Subquery[] {
  if (config.kind === 'legacy')
    return expandCatalog(config.catalog, expansionDate);
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
