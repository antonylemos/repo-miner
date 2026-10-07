import type { CollectionLimits } from '@/modules/discovery/model/collection.js';

export const DEFAULT_COLLECTION_LIMITS: CollectionLimits = {
  branchesPerPage: 100,
  commitsPerPage: 30,
  maxActivityRequestsPerCandidate: 20,
  maxActivityDurationMs: null,
};

/** GitHub rejects larger `per_page` values. */
export const MAX_PAGE_SIZE = 100;

export function isPageSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_PAGE_SIZE
  );
}

export function isPositiveCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

type PageSizes = Pick<CollectionLimits, 'commitsPerPage' | 'branchesPerPage'>;

/** Page numbers retain their original boundaries across all invocations. */
export function resolveResumeLimits(
  requested: CollectionLimits,
  explicit: Record<keyof PageSizes, boolean>,
  stored: PageSizes,
): CollectionLimits {
  for (const key of ['commitsPerPage', 'branchesPerPage'] as const)
    if (explicit[key] && requested[key] !== stored[key])
      throw new Error(
        `Resume must preserve the original ${key} (${stored[key]}).`,
      );
  return {
    ...requested,
    commitsPerPage: stored.commitsPerPage,
    branchesPerPage: stored.branchesPerPage,
  };
}
