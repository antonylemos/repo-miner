import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readCsv } from '@/common/csv.js';
import { sha256File } from '@/common/hash.js';
import { isRecord } from '@/common/records.js';
import type { SamplingFilter } from './config.js';

export type Candidate = {
  id: number;
  fullName: string;
  url: string;
  strategies: string;
  /** Null when the round was exported without an eligibility protocol. */
  status: string | null;
  /** Every `reason` of the candidate's rule results. */
  reasons: string[];
};

/** What the source files agreed on before any candidate was drawn. */
export type SourceChecks = {
  candidatesSha256: string;
  totalCandidates: number;
  byEligibility: Record<string, number> | null;
  unknownReasons: Record<string, number> | null;
};

export type Exclusions = {
  total: number;
  byStatus: Record<string, number>;
  /** A candidate with several excluded reasons counts once for each. */
  byReason: Record<string, number>;
};

export type Population = {
  run: { path: string; id: string };
  checks: SourceChecks;
  candidates: Candidate[];
  exclusions: Exclusions;
};

const ROUND_FILES = ['candidates.csv', 'coverage.json', 'manifest.json'];
const BASE_COLUMNS = ['id', 'full_name', 'url', 'strategies'];
const ELIGIBILITY_COLUMNS = ['eligibility_status', 'eligibility_results_json'];
/** The export adds this reason without recording it in `eligibility_results_json`. */
const UNRECORDED_REASON = 'pending_evaluation';

type Round = {
  directory: string;
  runId: string;
  candidatesSha256: string;
  coverage: Record<string, unknown>;
};

/** Requires the round's files and that candidates.csv still has the exported hash. */
async function openRound(directory: string): Promise<Round> {
  for (const file of ROUND_FILES)
    if (!existsSync(join(directory, file)))
      throw new Error(`The run directory does not contain ${file}.`);
  const manifest = readJson(join(directory, 'manifest.json'));
  const coverage = readJson(join(directory, 'coverage.json'));
  const expected = isRecord(manifest.sha256)
    ? manifest.sha256['candidates.csv']
    : undefined;
  if (typeof expected !== 'string')
    throw new Error(
      'manifest.json does not record the SHA-256 of candidates.csv.',
    );
  const runId = isRecord(manifest.run) ? manifest.run.id : undefined;
  if (typeof runId !== 'string')
    throw new Error('manifest.json does not record the run id.');
  const actual = await sha256File(join(directory, 'candidates.csv'));
  if (actual !== expected)
    throw new Error(
      `candidates.csv changed after the export: manifest.json records ${expected}, the file has ${actual}.`,
    );
  return { directory, runId, candidatesSha256: actual, coverage };
}

function readJson(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(value)) throw new Error(`${path} is not a JSON object.`);
  return value;
}

type RuleResult = { reason: string; status: string };

function parseResults(text: string, id: number): RuleResult[] {
  const value: unknown = JSON.parse(text === '' ? '[]' : text);
  if (!Array.isArray(value))
    throw new Error(
      `Candidate ${id}: eligibility_results_json is not an array.`,
    );
  return value.map((entry) => {
    if (!isRecord(entry))
      throw new Error(`Candidate ${id}: invalid eligibility result.`);
    return {
      reason: String(entry.reason ?? ''),
      status: String(entry.status ?? ''),
    };
  });
}

type ReadCandidate = Candidate & { unknownReasons: string[] };

async function readCandidates(
  path: string,
): Promise<{ candidates: ReadCandidate[]; eligible: boolean }> {
  const candidates: ReadCandidate[] = [];
  let columns: Map<string, number> | null = null;
  let eligible = false;
  let line = 0;
  for await (const row of readCsv(path)) {
    line += 1;
    if (columns === null) {
      columns = new Map(row.map((name, index) => [name, index]));
      const missing = BASE_COLUMNS.filter((name) => !columns?.has(name));
      if (missing.length > 0)
        throw new Error(
          `candidates.csv lacks the columns ${missing.join(', ')}.`,
        );
      eligible = ELIGIBILITY_COLUMNS.every((name) => columns?.has(name));
      continue;
    }
    if (row.length === 1 && row[0] === '') continue;
    if (row.length !== columns.size)
      throw new Error(
        `candidates.csv line ${line} has ${row.length} fields, expected ${columns.size}.`,
      );
    const field = (name: string) => row[columns?.get(name) as number] as string;
    const id = Number(field('id'));
    if (!Number.isSafeInteger(id))
      throw new Error(`candidates.csv line ${line} has an invalid id.`);
    const results = eligible
      ? parseResults(field('eligibility_results_json'), id)
      : [];
    candidates.push({
      id,
      fullName: field('full_name'),
      url: field('url'),
      strategies: field('strategies'),
      status: eligible ? field('eligibility_status') : null,
      reasons: results.map((result) => result.reason),
      unknownReasons: results
        .filter((result) => result.status === 'unknown')
        .map((result) => result.reason),
    });
  }
  if (columns === null) throw new Error('candidates.csv is empty.');
  return { candidates, eligible };
}

function countBy(values: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function sameCounts(
  label: string,
  expected: Record<string, number>,
  actual: Record<string, number>,
): void {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of [...keys].sort()) {
    const wanted = expected[key] ?? 0;
    const found = actual[key] ?? 0;
    if (wanted !== found)
      throw new Error(
        `${label} ${key}: coverage.json expects ${wanted}, candidates.csv has ${found}.`,
      );
  }
}

function countRecord(value: unknown, label: string): Record<string, number> {
  if (
    !isRecord(value) ||
    Object.values(value).some((count) => typeof count !== 'number')
  )
    throw new Error(`coverage.json ${label} is invalid.`);
  return value as Record<string, number>;
}

/** Compares the counts recomputed from the rows with what the export reported. */
function checkCounts(
  coverage: Record<string, unknown>,
  read: { candidates: ReadCandidate[]; eligible: boolean },
): Pick<SourceChecks, 'totalCandidates' | 'byEligibility' | 'unknownReasons'> {
  const totals = isRecord(coverage.totals) ? coverage.totals : {};
  const expectedTotal = totals.uniqueCandidates;
  if (typeof expectedTotal !== 'number')
    throw new Error('coverage.json does not record totals.uniqueCandidates.');
  if (expectedTotal !== read.candidates.length)
    throw new Error(
      `Total candidates: coverage.json expects ${expectedTotal}, candidates.csv has ${read.candidates.length}.`,
    );
  const hasCoverage = coverage.byEligibility !== undefined;
  if (hasCoverage !== read.eligible)
    throw new Error(
      'coverage.json and candidates.csv disagree on whether the round has eligibility.',
    );
  if (!read.eligible)
    return {
      totalCandidates: read.candidates.length,
      byEligibility: null,
      unknownReasons: null,
    };
  const byEligibility = countBy(
    read.candidates.map((candidate) => candidate.status as string),
  );
  sameCounts(
    'Eligibility status',
    countRecord(coverage.byEligibility, 'byEligibility'),
    byEligibility,
  );
  const unknownReasons = countBy(
    read.candidates
      .filter((candidate) => candidate.status === 'unknown')
      .flatMap((candidate) => [...new Set(candidate.unknownReasons)]),
  );
  const expectedReasons = {
    ...countRecord(coverage.unknownReasons, 'unknownReasons'),
  };
  delete expectedReasons[UNRECORDED_REASON];
  sameCounts('Unknown reason', expectedReasons, unknownReasons);
  return {
    totalCandidates: read.candidates.length,
    byEligibility,
    unknownReasons,
  };
}

function applyFilter(
  candidates: ReadCandidate[],
  filter: SamplingFilter | undefined,
): { kept: Candidate[]; exclusions: Exclusions } {
  const statuses = filter?.eligibilityStatus;
  const reasons = new Set(filter?.excludeReasons ?? []);
  const byStatus: string[] = [];
  const byReason: string[] = [];
  const kept: Candidate[] = [];
  let total = 0;
  for (const { unknownReasons: _ignored, ...candidate } of candidates) {
    if (
      statuses &&
      !(statuses as string[]).includes(candidate.status as string)
    ) {
      byStatus.push(candidate.status as string);
      total += 1;
      continue;
    }
    const matched = [...new Set(candidate.reasons)].filter((reason) =>
      reasons.has(reason),
    );
    if (matched.length > 0) {
      byReason.push(...matched);
      total += 1;
      continue;
    }
    kept.push(candidate);
  }
  return {
    kept,
    exclusions: {
      total,
      byStatus: countBy(byStatus),
      byReason: countBy(byReason),
    },
  };
}

/** Reads a round's candidates after verifying the source, then applies the filter. */
export async function readPopulation(
  runPath: string,
  filter?: SamplingFilter,
): Promise<Population> {
  const directory = resolve(runPath);
  const round = await openRound(directory);
  const read = await readCandidates(join(directory, 'candidates.csv'));
  if (filter !== undefined && !read.eligible)
    throw new Error(
      'The sample config declares a filter, but candidates.csv has no eligibility columns.',
    );
  const counts = checkCounts(round.coverage, read);
  const { kept, exclusions } = applyFilter(read.candidates, filter);
  return {
    run: { path: runPath, id: round.runId },
    checks: { candidatesSha256: round.candidatesSha256, ...counts },
    candidates: kept,
    exclusions,
  };
}
