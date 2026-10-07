import {
  DEFAULT_COLLECTION_LIMITS,
  isPageSize,
  isPositiveCount,
  MAX_PAGE_SIZE,
} from '@/modules/discovery/collection/limits.js';
import type { CollectionLimits } from '@/modules/discovery/model/collection.js';

export type DiscoverOptions = {
  queries?: string;
  output?: string;
  resume?: string;
  dryRun?: boolean;
  protocol?: string;
  activityMaxRequests?: string;
  activityCommitsPerPage?: string;
  activityBranchesPerPage?: string;
  activityMaxDurationMs?: string;
};

export function parseDiscoverOptions(
  options: DiscoverOptions,
): DiscoverOptions {
  if (options.dryRun) {
    if (hasActivityOptions(options))
      throw new Error(
        '--dry-run cannot collect activity or accept activity budgets.',
      );
    if (options.output || options.resume || !options.queries) {
      throw new Error(
        '--dry-run requires --queries and cannot be combined with --output or --resume.',
      );
    }
    return options;
  }
  if (
    options.resume &&
    (options.queries || options.output || options.protocol)
  ) {
    throw new Error(
      '--resume cannot be combined with --queries, --protocol or --output.',
    );
  }
  if (!options.resume && (!options.queries || !options.output)) {
    throw new Error('discover requires --queries and --output, or --resume.');
  }
  return options;
}

export function hasActivityOptions(command: DiscoverOptions): boolean {
  return [
    command.activityMaxRequests,
    command.activityCommitsPerPage,
    command.activityBranchesPerPage,
    command.activityMaxDurationMs,
  ].some((value) => value !== undefined);
}

export function limitsFromFlags(command: DiscoverOptions): CollectionLimits {
  const positive = (
    value: string | undefined,
    fallback: number,
    label: string,
  ): number => {
    const number = value === undefined ? fallback : Number(value);
    // The CLI also rejects integers beyond the safe range, which the store accepts.
    if (!isPositiveCount(number) || !Number.isSafeInteger(number))
      throw new Error(
        `${label} must be a positive integer <= ${Number.MAX_SAFE_INTEGER}.`,
      );
    return number;
  };
  const pageSize = (
    value: string | undefined,
    fallback: number,
    label: string,
  ): number => {
    const number = value === undefined ? fallback : Number(value);
    if (!isPageSize(number))
      throw new Error(
        `${label} must be a positive integer <= ${MAX_PAGE_SIZE}.`,
      );
    return number;
  };
  return {
    maxActivityRequestsPerCandidate: positive(
      command.activityMaxRequests,
      DEFAULT_COLLECTION_LIMITS.maxActivityRequestsPerCandidate,
      '--activity-max-requests',
    ),
    commitsPerPage: pageSize(
      command.activityCommitsPerPage,
      DEFAULT_COLLECTION_LIMITS.commitsPerPage,
      '--activity-commits-per-page',
    ),
    branchesPerPage: pageSize(
      command.activityBranchesPerPage,
      DEFAULT_COLLECTION_LIMITS.branchesPerPage,
      '--activity-branches-per-page',
    ),
    maxActivityDurationMs:
      command.activityMaxDurationMs === undefined
        ? null
        : positive(
            command.activityMaxDurationMs,
            1,
            '--activity-max-duration-ms',
          ),
  };
}
