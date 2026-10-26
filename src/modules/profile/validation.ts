import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readCsv } from '@/common/csv.js';
import { compareCodePoints } from '@/common/order.js';
import { isRecord } from '@/common/records.js';
import type { CachedPage } from './api-cache.js';
import { countForks } from './popularity.js';

export const VALIDATION_COLUMNS = [
  'id',
  'full_name',
  'measure',
  'at',
  'reconstructed',
  'recorded',
  'difference',
];

export type DiscoveryObservation = {
  measure: 'stars' | 'forks';
  /** When the discovery observed the value. */
  at: string;
  value: number;
};

export type ValidationRow = {
  id: string;
  fullName: string;
  measure: 'stars' | 'forks' | 'commits';
  at: string;
  /**
   * What the profile measured: the forks rebuilt at `at`, the star count the API
   * gave when the pages were fetched (not at `at`), or the commits the API listed.
   */
  reconstructed: number;
  /** What it is compared with: the value the discovery recorded, or the commits of the clone. */
  recorded: number;
  difference: number;
};

/** The field of an observation's data that holds each measure. */
const FIELDS = { stars: 'stargazerCount', forks: 'forks_count' } as const;

function observationsOf(evidence: string): DiscoveryObservation[] {
  const parsed: unknown = JSON.parse(evidence);
  const observations = isRecord(parsed) ? parsed.observations : null;
  if (!Array.isArray(observations)) return [];
  const found = new Map<string, DiscoveryObservation>();
  for (const observation of observations) {
    if (
      !isRecord(observation) ||
      observation.status !== 'ok' ||
      typeof observation.observedAt !== 'string' ||
      !isRecord(observation.data)
    )
      continue;
    for (const measure of ['stars', 'forks'] as const) {
      const value = observation.data[FIELDS[measure]];
      if (typeof value !== 'number') continue;
      found.set(`${measure}|${observation.observedAt}|${value}`, {
        measure,
        at: observation.observedAt,
        value,
      });
    }
  }
  return [...found.values()];
}

/**
 * The star and fork counts the discovery recorded, with the instant of each
 * observation, for the given repository ids. The file is streamed because a
 * discovery export is large.
 */
export async function readDiscoveryObservations(
  discovery: string,
  ids: Set<string>,
): Promise<Map<string, DiscoveryObservation[]>> {
  const path = join(discovery, 'candidates.csv');
  if (!existsSync(path)) throw new Error(`${path} does not exist.`);
  const result = new Map<string, DiscoveryObservation[]>();
  let columns: { id: number; evidence: number } | null = null;
  for await (const row of readCsv(path)) {
    if (columns === null) {
      columns = {
        id: row.indexOf('id'),
        evidence: row.indexOf('evidence_json'),
      };
      if (columns.id === -1 || columns.evidence === -1)
        throw new Error(`${path} lacks the columns id, evidence_json.`);
      continue;
    }
    const id = row[columns.id] as string;
    if (!ids.has(id)) continue;
    result.set(id, observationsOf(row[columns.evidence] ?? '[]'));
  }
  return result;
}

export type Reconstruction = {
  id: string;
  fullName: string;
  observations: DiscoveryObservation[];
  /** Null when the API had no answer for the repository. */
  /** Today's star count, or null when the API had none. */
  starCount: number | null;
  forks: CachedPage[] | null;
  /** Commits listed by the API up to the snapshot commit, or null. */
  apiCommits: number | null;
  cloneCommits: number;
  referenceAt: string;
};

/**
 * Rebuilds forks at the instant of each discovery observation, and compares them
 * and today's star count with what the discovery recorded, and the commits the API
 * listed with the ones in the clone. A value the discovery did not record gives
 * no row; a difference is data, not an error.
 */
export function compareWithDiscovery(input: Reconstruction): ValidationRow[] {
  const rows: ValidationRow[] = [];
  const row = (
    measure: ValidationRow['measure'],
    at: string,
    reconstructed: number,
    recorded: number,
  ) =>
    rows.push({
      id: input.id,
      fullName: input.fullName,
      measure,
      at,
      reconstructed,
      recorded,
      difference: reconstructed - recorded,
    });
  const observed = (measure: DiscoveryObservation['measure']) =>
    input.observations
      .filter((observation) => observation.measure === measure)
      .sort((a, b) => compareCodePoints(a.at, b.at) || a.value - b.value);
  if (input.starCount !== null)
    for (const observation of observed('stars'))
      row('stars', observation.at, input.starCount, observation.value);
  if (input.forks !== null)
    for (const observation of observed('forks'))
      row(
        'forks',
        observation.at,
        countForks(input.forks, observation.at),
        observation.value,
      );
  if (input.apiCommits !== null)
    row('commits', input.referenceAt, input.apiCommits, input.cloneCommits);
  return rows;
}
