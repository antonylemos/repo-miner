import { isIsoDate } from './catalog.js';
import type { Interval, Query, Subquery } from './types.js';

type Slice = { label: string; qualifier: string };

const DAY_MS = 86_400_000;

/** Expands catalog queries into concrete searches; the result depends only on the queries and the date. */
export function expandQueries(
  queries: Query[],
  expansionDate: string,
  repositoryQualifier: string | null,
): Subquery[] {
  if (!isIsoDate(expansionDate)) {
    throw new Error(`Invalid expansion date "${expansionDate}"`);
  }
  return queries.flatMap((query) =>
    slicesFor(query, expansionDate).map(({ label, qualifier }) => ({
      id: label ? `${query.id}#${label}` : query.id,
      queryId: query.id,
      strategy: query.strategy,
      endpoint: query.endpoint,
      q: [
        query.q,
        query.endpoint === 'repositories' ? repositoryQualifier : '',
        qualifier,
      ]
        .filter(Boolean)
        .join(' '),
      partitionLabel: label,
    })),
  );
}

function slicesFor(query: Query, expansionDate: string): Slice[] {
  const partition = query.partition;
  if (!partition) return [{ label: '', qualifier: '' }];
  if (partition.by === 'size') return sizeSlices(partition.bounds);
  return createdSlices(partition.from, partition.interval, expansionDate);
}

function sizeSlices(bounds: number[]): Slice[] {
  const closed = bounds.slice(0, -1).map((lower, index) => {
    const qualifier = `size:${lower}..${bounds[index + 1] - 1}`;
    return { label: qualifier, qualifier };
  });
  const open = `size:>=${bounds[bounds.length - 1]}`;
  return [...closed, { label: open, qualifier: open }];
}

function createdSlices(
  from: string,
  interval: Interval,
  expansionDate: string,
): Slice[] {
  // A leading bucket avoids one empty subquery per period since GitHub's founding.
  const leading = `created:<${from}`;
  const slices: Slice[] = [{ label: leading, qualifier: leading }];
  const current = periodStart(parseDate(expansionDate), interval);
  let start = parseDate(from);
  while (start.getTime() < current.getTime()) {
    const next = addPeriod(start, interval);
    const end = new Date(next.getTime() - DAY_MS);
    slices.push({
      label: `created:${periodLabel(start, interval)}`,
      qualifier: `created:${formatDate(start)}..${formatDate(end)}`,
    });
    start = next;
  }
  const open = `created:>=${formatDate(start)}`;
  slices.push({ label: open, qualifier: open });
  return slices;
}

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthsIn(interval: Interval): number {
  return interval === 'month' ? 1 : interval === 'quarter' ? 3 : 12;
}

function addPeriod(date: Date, interval: Interval): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + monthsIn(interval), 1),
  );
}

function periodStart(date: Date, interval: Interval): Date {
  const month = date.getUTCMonth();
  const startMonth = month - (month % monthsIn(interval));
  return new Date(Date.UTC(date.getUTCFullYear(), startMonth, 1));
}

function periodLabel(date: Date, interval: Interval): string {
  const year = date.getUTCFullYear();
  if (interval === 'year') return String(year);
  if (interval === 'quarter') {
    return `${year}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
  }
  return formatDate(date).slice(0, 7);
}
