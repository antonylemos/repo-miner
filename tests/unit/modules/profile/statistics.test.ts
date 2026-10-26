import { describe, expect, it } from 'vitest';
import {
  formatNumber,
  quantile,
  summarize,
} from '@/modules/profile/statistics.js';

describe('quantile', () => {
  it('should interpolate between the sorted positions', () => {
    const sorted = [1, 2, 3, 10];
    expect(quantile(sorted, 0.5)).toBe(2.5);
    expect(quantile(sorted, 0.25)).toBe(1.75);
    expect(quantile(sorted, 0.75)).toBe(4.75);
    expect(quantile(sorted, 0)).toBe(1);
    expect(quantile(sorted, 1)).toBe(10);
  });

  it('should return the only value of a single value', () => {
    expect(quantile([7], 0.75)).toBe(7);
  });
});

describe('summarize', () => {
  it('should give the median, quartiles, IQR, minimum and maximum of numbers', () => {
    expect(summarize('x', ['10', '1', '3', '2'])).toEqual({
      kind: 'numeric',
      name: 'x',
      n: 4,
      empty: 0,
      median: 2.5,
      q1: 1.75,
      q3: 4.75,
      iqr: 3,
      min: 1,
      max: 10,
    });
  });

  it('should leave the empty values out and count them', () => {
    const values = [...Array.from({ length: 98 }, (_, i) => String(i)), '', ''];
    const summary = summarize('stars', values);
    expect(summary).toMatchObject({ kind: 'numeric', n: 98, empty: 2 });
  });

  it('should count each category with its share of the repositories with a value', () => {
    const summary = summarize('domain', ['a', 'b', 'a', '', 'a']);
    expect(summary).toEqual({
      kind: 'categorical',
      name: 'domain',
      multiple: false,
      n: 4,
      empty: 1,
      categories: [
        { value: 'a', n: 3, percent: 75 },
        { value: 'b', n: 1, percent: 25 },
      ],
    });
  });

  it('should count a repository in each value of a multi-value variable', () => {
    const summary = summarize('types', [
      'communication;host → remote',
      'host → remote',
    ]);
    expect(summary).toMatchObject({
      kind: 'categorical',
      multiple: true,
      n: 2,
    });
    expect((summary as { categories: unknown }).categories).toEqual([
      { value: 'host → remote', n: 2, percent: 100 },
      { value: 'communication', n: 1, percent: 50 },
    ]);
  });

  it('should order equal counts by value', () => {
    const summary = summarize('x', ['b', 'a']);
    expect(
      (summary as { categories: Array<{ value: string }> }).categories.map(
        (category) => category.value,
      ),
    ).toEqual(['a', 'b']);
  });

  it('should treat text as categories even when some values look like numbers', () => {
    expect(summarize('x', ['1', 'two']).kind).toBe('categorical');
  });

  it('should treat a variable with only empty values as categorical', () => {
    expect(summarize('x', ['', ''])).toMatchObject({
      kind: 'categorical',
      n: 0,
      empty: 2,
      categories: [],
    });
  });
});

describe('formatNumber', () => {
  it('should print at most two decimals with a point', () => {
    expect(formatNumber(2.5)).toBe('2.5');
    expect(formatNumber(3)).toBe('3');
    expect(formatNumber(1 / 3)).toBe('0.33');
    expect(formatNumber(4.75)).toBe('4.75');
  });
});
