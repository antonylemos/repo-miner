import type { Scope, StoredCandidate } from './types.js';

export type EffectivePush = {
  pushedAt: string | null;
  source: 'enrichment' | 'search' | null;
  observedAt: string | null;
};

/** A push must be a nonempty string representing a finite timestamp. */
export function isUsablePush(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

/** Valid successful enrichment takes precedence regardless of observation order. */
export function effectivePush(candidate: StoredCandidate): EffectivePush {
  const enrichment = candidate.enrichment;
  const enrichedPush = enrichment?.data?.pushedAt;
  if (enrichment?.status === 'ok' && isUsablePush(enrichedPush)) {
    return {
      pushedAt: enrichedPush,
      source: 'enrichment',
      observedAt: enrichment.fetchedAt,
    };
  }
  const searchedPush = candidate.metadata.pushed_at;
  if (isUsablePush(searchedPush)) {
    return {
      pushedAt: searchedPush,
      source: 'search',
      observedAt: candidate.metadataObservedAt,
    };
  }
  return { pushedAt: null, source: null, observedAt: null };
}

/** Classifies a candidate against the run's activity threshold. */
export function candidateScope(
  push: EffectivePush,
  pushedSince: string,
): Scope {
  if (push.pushedAt === null) return 'unknown';
  const pushed = Date.parse(push.pushedAt);
  if (Number.isNaN(pushed)) return 'unknown';
  return pushed >= Date.parse(`${pushedSince}T00:00:00Z`)
    ? 'in_scope'
    : 'out_of_scope_temporal';
}
