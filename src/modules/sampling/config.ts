import { isRecord } from '@/common/records.js';

export const ELIGIBILITY_STATUSES = [
  'pass',
  'fail',
  'unknown',
  'not_applied',
] as const;
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];

export type SamplingFilter = {
  eligibilityStatus?: EligibilityStatus[];
  excludeReasons?: string[];
};
export type SamplingConfig = {
  run: string;
  size: number;
  seed: string;
  filter?: SamplingFilter;
};

function rejectUnknownFields(
  input: Record<string, unknown>,
  allowed: string[],
  where: string,
): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    throw new Error(
      `Invalid sample config: unknown ${where} field ${unknown.join(', ')}`,
    );
}

function stringList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item === '')
  )
    throw new Error(
      `Invalid sample config: ${field} must be an array of non-empty strings`,
    );
  return value as string[];
}

function parseFilter(input: unknown): SamplingFilter {
  if (!isRecord(input))
    throw new Error('Invalid sample config: filter must be an object');
  rejectUnknownFields(input, ['eligibilityStatus', 'excludeReasons'], 'filter');
  const filter: SamplingFilter = {};
  if (input.eligibilityStatus !== undefined) {
    const statuses = stringList(
      input.eligibilityStatus,
      'filter.eligibilityStatus',
    );
    const invalid = statuses.filter(
      (status) => !(ELIGIBILITY_STATUSES as readonly string[]).includes(status),
    );
    if (invalid.length > 0)
      throw new Error(
        `Invalid sample config: unknown eligibility status ${invalid.join(', ')}`,
      );
    filter.eligibilityStatus = statuses as EligibilityStatus[];
  }
  if (input.excludeReasons !== undefined)
    filter.excludeReasons = stringList(
      input.excludeReasons,
      'filter.excludeReasons',
    );
  return filter;
}

export function parseSamplingConfig(input: unknown): SamplingConfig {
  if (!isRecord(input))
    throw new Error('Invalid sample config: expected an object');
  rejectUnknownFields(input, ['run', 'size', 'seed', 'filter'], 'config');
  if (typeof input.run !== 'string' || input.run === '')
    throw new Error('Invalid sample config: run must be a non-empty string');
  if (!Number.isSafeInteger(input.size) || (input.size as number) <= 0)
    throw new Error('Invalid sample config: size must be a positive integer');
  if (typeof input.seed !== 'string' || input.seed === '')
    throw new Error('Invalid sample config: seed must be a non-empty string');
  return {
    run: input.run,
    size: input.size as number,
    seed: input.seed,
    ...(input.filter === undefined
      ? {}
      : { filter: parseFilter(input.filter) }),
  };
}
