import { createHash } from 'node:crypto';
import type {
  Endpoint,
  Interval,
  Partition,
  Query,
  Strategy,
} from './types.js';

// Lowercase words joined by single `-` or `_`, so a label is safe in `;`-separated CSV cells and Markdown tables.
const STRATEGY_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const VALID_ENDPOINTS = new Set<Endpoint>(['repositories', 'code']);
const VALID_INTERVALS = new Set<Interval>(['month', 'quarter', 'year']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// The expansion generates these qualifiers, so hand-written ones would conflict.
const RESERVED_QUALIFIER = /(?:^|\s)-?(?:pushed|created|size):/i;

export function parseQueries(input: unknown): Query[] {
  if (!Array.isArray(input)) {
    throw new Error('Invalid catalog: expected a queries array');
  }
  if (input.length === 0) {
    throw new Error('Invalid catalog: queries must not be empty');
  }
  const seenIds = new Set<string>();
  return input.map((value, index) => {
    const query = parseQuery(value, index);
    if (seenIds.has(query.id)) {
      throw new Error(
        `Invalid query at index ${index}: duplicate id "${query.id}"`,
      );
    }
    seenIds.add(query.id);
    return query;
  });
}

function parseQuery(value: unknown, index: number): Query {
  if (!isRecord(value)) {
    throw new Error(`Invalid query at index ${index}: expected an object`);
  }

  const { id, strategy, endpoint, q, rationale } = value;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error(
      `Invalid query at index ${index}: id must be a non-empty string`,
    );
  }
  if (!isStrategy(strategy)) {
    throw new Error(
      `Invalid query "${id}": strategy must be a lowercase label of letters, digits, "-" or "_"`,
    );
  }
  if (!isEndpoint(endpoint)) {
    throw new Error(
      `Invalid query "${id}": endpoint must be repositories or code`,
    );
  }
  if (typeof q !== 'string' || q.trim().length === 0) {
    throw new Error(`Invalid query "${id}": q must be a non-empty string`);
  }
  if (RESERVED_QUALIFIER.test(q)) {
    throw new Error(
      `Invalid query "${id}": q uses a reserved qualifier (pushed:, created: or size:)`,
    );
  }
  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    throw new Error(
      `Invalid query "${id}": rationale must be a non-empty string`,
    );
  }

  const query: Query = { id, strategy, endpoint, q, rationale };
  if (value.partition !== undefined) {
    query.partition = parsePartition(value.partition, id, endpoint);
  }
  return query;
}

function parsePartition(
  value: unknown,
  id: string,
  endpoint: Endpoint,
): Partition {
  if (!isRecord(value)) {
    throw new Error(`Invalid query "${id}": partition must be an object`);
  }
  if (value.by === 'created') {
    if (endpoint !== 'repositories') {
      throw new Error(
        `Invalid query "${id}": created partitions require the repositories endpoint`,
      );
    }
    if (!isInterval(value.interval)) {
      throw new Error(
        `Invalid query "${id}": partition.interval must be month, quarter or year`,
      );
    }
    if (!isIsoDate(value.from) || !isPeriodStart(value.from, value.interval)) {
      throw new Error(
        `Invalid query "${id}": partition.from must be the first day of a ${value.interval}`,
      );
    }
    return { by: 'created', from: value.from, interval: value.interval };
  }
  if (value.by === 'size') {
    if (endpoint !== 'code') {
      throw new Error(
        `Invalid query "${id}": size partitions require the code endpoint`,
      );
    }
    if (!isIncreasingFromZero(value.bounds)) {
      throw new Error(
        `Invalid query "${id}": partition.bounds must be at least two increasing integers starting at 0`,
      );
    }
    return { by: 'size', bounds: value.bounds };
  }
  throw new Error(
    `Invalid query "${id}": partition.by must be created or size`,
  );
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
}

function isPeriodStart(date: string, interval: Interval): boolean {
  const [, month, day] = date.split('-').map(Number);
  if (day !== 1) return false;
  if (interval === 'quarter') return (month - 1) % 3 === 0;
  if (interval === 'year') return month === 1;
  return true;
}

function isIncreasingFromZero(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value[0] === 0 &&
    value.every(
      (bound, index) =>
        Number.isInteger(bound) &&
        (index === 0 || (bound as number) > (value[index - 1] as number)),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStrategy(value: unknown): value is Strategy {
  return typeof value === 'string' && STRATEGY_PATTERN.test(value);
}

function isEndpoint(value: unknown): value is Endpoint {
  return typeof value === 'string' && VALID_ENDPOINTS.has(value as Endpoint);
}

function isInterval(value: unknown): value is Interval {
  return typeof value === 'string' && VALID_INTERVALS.has(value as Interval);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    // Array order is meaningful for queries, so only object keys are sorted.
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Fingerprints a catalog so a resumed run can detect changed search inputs. */
export function catalogHash(catalog: { queries: Query[] }): string {
  return createHash('sha256')
    .update(canonicalJson({ queries: catalog.queries }))
    .digest('hex');
}
