import type { Scope, StoredCandidate } from './types.js';

export type EffectivePush = {
  pushedAt: string | null;
  source: 'enrichment' | 'search' | null;
  observedAt: string | null;
};

/** Prefers enrichment because it is fetched after the search and reflects later activity. */
export function effectivePush(candidate: StoredCandidate): EffectivePush {
  const enrichment = candidate.enrichment;
  const enrichedPush = enrichment?.data?.pushedAt;
  if (enrichment?.status === 'ok' && typeof enrichedPush === 'string') {
    return {
      pushedAt: enrichedPush,
      source: 'enrichment',
      observedAt: enrichment.fetchedAt,
    };
  }
  const searchedPush = candidate.metadata.pushed_at;
  if (typeof searchedPush === 'string') {
    return {
      pushedAt: searchedPush,
      source: 'search',
      observedAt: candidate.firstSeenAt,
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
