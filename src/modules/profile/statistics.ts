import { compareCodePoints } from '@/common/order.js';

export type NumericSummary = {
  kind: 'numeric';
  name: string;
  /** Values that are not empty. */
  n: number;
  empty: number;
  median: number;
  q1: number;
  q3: number;
  iqr: number;
  min: number;
  max: number;
};

export type CategorySummary = {
  kind: 'categorical';
  name: string;
  /** True when a value holds several `;`-separated values. */
  multiple: boolean;
  /** Repositories with a value. */
  n: number;
  empty: number;
  /** Largest first, ties by value; the percentage is over `n`. */
  categories: Array<{ value: string; n: number; percent: number }>;
};

export type VariableSummary = NumericSummary | CategorySummary;

const NUMBER = /^-?\d+(\.\d+)?$/;

/** The quantile of sorted values by linear interpolation (type 7 of R, numpy and pandas). */
export function quantile(sorted: number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return (
    (sorted[lower] as number) +
    (position - lower) * ((sorted[upper] as number) - (sorted[lower] as number))
  );
}

/** A number with at most two decimals and a decimal point. */
export function formatNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

/**
 * Summarizes one variable. It is numeric when every value that is not empty is
 * a number, and categorical otherwise, also when all values are empty.
 */
export function summarize(name: string, values: string[]): VariableSummary {
  const filled = values.filter((value) => value !== '');
  const empty = values.length - filled.length;
  if (filled.length > 0 && filled.every((value) => NUMBER.test(value))) {
    const sorted = filled.map(Number).sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    return {
      kind: 'numeric',
      name,
      n: filled.length,
      empty,
      median: quantile(sorted, 0.5),
      q1,
      q3,
      iqr: q3 - q1,
      min: sorted[0] as number,
      max: sorted[sorted.length - 1] as number,
    };
  }
  const multiple = filled.some((value) => value.includes(';'));
  const counts = new Map<string, number>();
  for (const value of filled) {
    const own = multiple
      ? new Set(value.split(';').filter((item) => item !== ''))
      : [value];
    for (const item of own) counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  const categories = [...counts]
    .map(([value, n]) => ({ value, n, percent: (n / filled.length) * 100 }))
    .sort((a, b) => b.n - a.n || compareCodePoints(a.value, b.value));
  return {
    kind: 'categorical',
    name,
    multiple,
    n: filled.length,
    empty,
    categories,
  };
}
