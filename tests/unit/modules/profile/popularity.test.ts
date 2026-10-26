import { page } from '@tests/profile-helpers.js';
import { describe, expect, it } from 'vitest';
import {
  countForks,
  readCreatedAt,
  readStarCount,
} from '@/modules/profile/popularity.js';

const AT = '2026-10-12T00:00:00.000Z';

describe('readStarCount', () => {
  it('should read the count of the response', () => {
    expect(readStarCount(page({ count: 3862 }))).toBe(3862);
    expect(readStarCount(page({ count: 0 }))).toBe(0);
  });

  it('should reject a response without a count', () => {
    expect(() => readStarCount(page({ message: 'x' }))).toThrow(/count/);
    expect(() => readStarCount(page([]))).toThrow(/count/);
  });
});

describe('readCreatedAt', () => {
  it('should read the creation instant of the repository', () => {
    expect(readCreatedAt(page({ created_at: '2011-01-26T19:01:12Z' }))).toBe(
      '2011-01-26T19:01:12Z',
    );
  });

  it('should reject a response without a valid created_at', () => {
    expect(() => readCreatedAt(page({}))).toThrow(/created_at/);
    expect(() => readCreatedAt(page({ created_at: 'x' }))).toThrow(
      /created_at/,
    );
  });
});

describe('countForks', () => {
  it('should leave out a fork created after the reference instant', () => {
    const forks = [
      { created_at: '2026-09-01T00:00:00Z' },
      { created_at: '2026-10-12T00:00:00Z' },
      { created_at: '2026-10-13T00:00:00Z' },
    ];
    expect(countForks([page(forks)], AT)).toBe(2);
  });

  it('should count none for an empty list', () => {
    expect(countForks([page([])], AT)).toBe(0);
  });
});
