import { query } from '@tests/helpers.js';
import { describe, expect, it } from 'vitest';
import {
  intersections,
  strategyCounts,
  strategyLabels,
} from '@/modules/discovery/report/common.js';

const row = (id: number, ...strategies: string[]) => ({ id, strategies });

describe('strategy labels', () => {
  it('should list the catalog labels in order of first appearance', () => {
    expect(
      strategyLabels([
        query({ id: 'a', strategy: 'beta' }),
        query({ id: 'b', strategy: 'alpha' }),
        query({ id: 'c', strategy: 'beta' }),
      ]),
    ).toEqual(['beta', 'alpha']);
  });
});

describe('strategy counts and intersections', () => {
  it('should count a single label and have no pairs', () => {
    const rows = [row(1, 'solo'), row(2, 'solo')];
    expect(strategyCounts(rows, ['solo'])).toEqual({ solo: 2 });
    expect(intersections(rows, ['solo'])).toEqual({
      exclusive: { solo: 2 },
      pairs: [],
      all: 2,
    });
  });

  it('should report zero for labels without candidates', () => {
    expect(strategyCounts([], ['a', 'b'])).toEqual({ a: 0, b: 0 });
    expect(intersections([], ['a', 'b'])).toEqual({
      exclusive: { a: 0, b: 0 },
      pairs: [{ left: 'a', right: 'b', count: 0 }],
      all: 0,
    });
  });

  it('should compute exclusive, pair and full intersections for three labels', () => {
    const rows = [
      row(1, 'a', 'b', 'c'),
      row(2, 'a', 'b'),
      row(3, 'a'),
      row(4, 'c'),
    ];
    expect(strategyCounts(rows, ['a', 'b', 'c'])).toEqual({
      a: 3,
      b: 2,
      c: 2,
    });
    expect(intersections(rows, ['a', 'b', 'c'])).toEqual({
      exclusive: { a: 1, b: 0, c: 1 },
      pairs: [
        { left: 'a', right: 'b', count: 2 },
        { left: 'a', right: 'c', count: 1 },
        { left: 'b', right: 'c', count: 1 },
      ],
      all: 1,
    });
  });

  it('should produce six pairs for four labels', () => {
    const labels = ['a', 'b', 'c', 'd'];
    const result = intersections([row(1, 'a', 'b', 'c', 'd')], labels);
    expect(result.pairs).toHaveLength(6);
    expect(result.pairs.every(({ count }) => count === 1)).toBe(true);
    expect(result.all).toBe(1);
    expect(result.exclusive).toEqual({ a: 0, b: 0, c: 0, d: 0 });
  });
});
