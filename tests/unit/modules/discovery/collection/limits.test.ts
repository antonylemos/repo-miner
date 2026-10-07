import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLLECTION_LIMITS,
  isPageSize,
  isPositiveCount,
  MAX_PAGE_SIZE,
  resolveResumeLimits,
} from '@/modules/discovery/collection/limits.js';

describe('collection limit predicates', () => {
  it.each([
    [0, false],
    [1, true],
    [100, true],
    [101, false],
    [1.5, false],
    [Number.NaN, false],
    ['30', false],
  ])('should classify page size %j as %s', (value, expected) =>
    expect(isPageSize(value)).toBe(expected),
  );
  it.each([
    [0, false],
    [1, true],
    [101, true],
    [1.5, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [null, false],
  ])('should classify count %j as %s', (value, expected) =>
    expect(isPositiveCount(value)).toBe(expected),
  );
  it('should cap page sizes at the GitHub maximum', () =>
    expect(MAX_PAGE_SIZE).toBe(100));
});

describe('resolveResumeLimits', () => {
  const requested = {
    ...DEFAULT_COLLECTION_LIMITS,
    maxActivityRequestsPerCandidate: 7,
  };
  const none = { commitsPerPage: false, branchesPerPage: false };

  it('should preserve the stored page sizes and keep the other requested limits', () =>
    expect(
      resolveResumeLimits(requested, none, {
        commitsPerPage: 50,
        branchesPerPage: 20,
      }),
    ).toEqual({
      ...requested,
      commitsPerPage: 50,
      branchesPerPage: 20,
    }));
  it('should accept an explicit size equal to the stored one', () =>
    expect(
      resolveResumeLimits(
        { ...requested, commitsPerPage: 50 },
        { ...none, commitsPerPage: true },
        { commitsPerPage: 50, branchesPerPage: 100 },
      ).commitsPerPage,
    ).toBe(50));
  it.each(['commitsPerPage', 'branchesPerPage'] as const)(
    'should reject an explicit %s that differs from the stored size',
    (key) =>
      expect(() =>
        resolveResumeLimits(
          { ...requested, [key]: 10 },
          { ...none, [key]: true },
          { commitsPerPage: 30, branchesPerPage: 100 },
        ),
      ).toThrow(
        `Resume must preserve the original ${key} (${key === 'commitsPerPage' ? 30 : 100}).`,
      ),
  );
});
