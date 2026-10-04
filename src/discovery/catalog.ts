import { createHash } from 'node:crypto';
import type { Catalog, Query, Strategy } from './types.js';

const VALID_STRATEGIES = new Set<Strategy>([
  'terminology',
  'technology',
  'broader',
]);
const VALID_ENDPOINTS = new Set<Query['endpoint']>(['repositories', 'code']);

/** Validates untrusted JSON and returns only the fields the discovery runner uses. */
export function parseCatalog(input: unknown): Catalog {
  if (
    !isRecord(input) ||
    input.version !== 1 ||
    !Array.isArray(input.queries)
  ) {
    throw new Error('Invalid catalog: expected version 1 and a queries array');
  }
  if (input.queries.length === 0) {
    throw new Error('Invalid catalog: queries must not be empty');
  }

  const seenIds = new Set<string>();
  const queries = input.queries.map((value, index) => {
    const query = parseQuery(value, index);
    if (seenIds.has(query.id)) {
      throw new Error(
        `Invalid query at index ${index}: duplicate id "${query.id}"`,
      );
    }
    seenIds.add(query.id);
    return query;
  });

  return { version: 1, queries };
}

function parseQuery(value: unknown, index: number): Query {
  if (!isRecord(value)) {
    throw new Error(`Invalid query at index ${index}: expected an object`);
  }

  const { id, strategy, endpoint, q } = value;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error(
      `Invalid query at index ${index}: id must be a non-empty string`,
    );
  }
  if (!isStrategy(strategy)) {
    throw new Error(`Invalid query "${id}": unknown strategy`);
  }
  if (!isEndpoint(endpoint)) {
    throw new Error(
      `Invalid query "${id}": endpoint must be repositories or code`,
    );
  }
  if (typeof q !== 'string' || q.trim().length === 0) {
    throw new Error(`Invalid query "${id}": q must be a non-empty string`);
  }

  return { id, strategy, endpoint, q };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStrategy(value: unknown): value is Strategy {
  return typeof value === 'string' && VALID_STRATEGIES.has(value as Strategy);
}

function isEndpoint(value: unknown): value is Query['endpoint'] {
  return (
    typeof value === 'string' && VALID_ENDPOINTS.has(value as Query['endpoint'])
  );
}

function canonicalJson(value: unknown): string {
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
export function catalogHash(catalog: Catalog): string {
  return createHash('sha256').update(canonicalJson(catalog)).digest('hex');
}
