import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAcquisition } from '@tests/mining-helpers.js';
import { temporaryDirectory } from '@tests/sampling-helpers.js';
import { readCsvRecords, writeCsv } from '@/common/csv.js';
import type { CachedPage } from '@/modules/profile/api-cache.js';
import { CLONE_COLUMNS } from '@/modules/sampling/clone.js';

/** A profile config with one variable of each kind, over the given acquisition. */
export function profileConfig(acquisition: string, overrides = {}) {
  return {
    acquisition,
    version: '1',
    languages: {
      measured: ['TypeScript', 'CSS', 'Python'],
      frontend: ['TypeScript', 'CSS'],
      excludeFiles: ['**/package-lock.json'],
    },
    annotations: [
      { column: 'repo_type', name: 'domain' },
      { column: 'approaches', name: 'approach', multipleLabel: 'hybrid' },
    ],
    reviews: [
      {
        name: 'snapshot_apps',
        files: 'reviews/structure/[0-9]*.md',
        statuses: ['final'],
        number: 'Apps:\\s*(\\d+)',
      },
      {
        name: 'unrelated_units',
        files: 'reviews/composition/[0-9]*.md',
        statuses: ['final'],
        list: 'Unrelated:\\s*(.+?)\\.?\\s*$',
        separator: ',',
        empty: ['none'],
      },
      {
        name: 'relation_types',
        files: 'reviews/composition/[0-9]*.md',
        statuses: ['final'],
        column: { section: 'Relations', header: 'Type' },
      },
    ],
    derived: [
      { name: 'units', difference: ['snapshot_apps', 'unrelated_units'] },
    ],
    ...overrides,
  };
}

export type ProfileFixtureRepository = {
  fullName: string;
  files?: Record<string, string>;
  /** Commit of the snapshot and of the clone; defaults to a fixed 40-character SHA. */
  commit?: string;
  /** `attempted_at` of the clone; defaults to 2026-10-12T00:00:00.000Z. */
  referenceAt?: string;
  columns?: Record<string, string>;
  /** Leaves the repository out of `clones.csv`. */
  notCloned?: boolean;
  /** Does not create the clone directory. */
  noClone?: boolean;
};

export const FIXTURE_COMMIT = 'a'.repeat(40);

/**
 * An acquisition with the columns the profile reads, and the sample it
 * records: `clones.csv` and one empty directory per clone.
 */
export async function createProfileFixture(
  repositories: ProfileFixtureRepository[],
) {
  const acquisition = await createAcquisition(
    repositories.map((repository) => ({
      fullName: repository.fullName,
      files: repository.files ?? { 'src/index.ts': 'export const n = 1;\n' },
    })),
  );
  const sample = join(temporaryDirectory(), 'sample');
  mkdirSync(join(sample, 'repos'), { recursive: true });

  const columns = [
    ...new Set(repositories.flatMap((r) => Object.keys(r.columns ?? {}))),
  ];
  const original = await readCsvRecords(
    join(acquisition.directory, 'acquisition.csv'),
  );
  await writeCsv(
    join(acquisition.directory, 'acquisition.csv'),
    ['id', 'full_name', 'commit_sha', 'content_sha256', ...columns],
    original.map((row, index) => {
      const repository = repositories[index] as ProfileFixtureRepository;
      return [
        row.id,
        row.full_name,
        repository.commit ?? FIXTURE_COMMIT,
        row.content_sha256,
        ...columns.map((column) => repository.columns?.[column] ?? ''),
      ];
    }),
  );
  writeFileSync(
    join(acquisition.directory, 'manifest.json'),
    JSON.stringify({ schema: 1, config: { sample } }),
  );

  await writeCsv(
    join(sample, 'clones.csv'),
    CLONE_COLUMNS,
    repositories.flatMap((repository, index) => {
      if (repository.notCloned === true) return [];
      const dir = repository.fullName.replace('/', '__');
      if (repository.noClone !== true)
        mkdirSync(join(sample, 'repos', dir), { recursive: true });
      return [
        [
          index + 1,
          index + 1,
          repository.fullName,
          'cloned',
          repository.commit ?? FIXTURE_COMMIT,
          'main',
          repository.referenceAt ?? '2026-10-12T00:00:00.000Z',
          '',
          '',
        ],
      ];
    }),
  );
  return { acquisition: acquisition.directory, sample };
}

/** A page of the GitHub API with the given body. */
export function page(body: unknown, status = 200): CachedPage {
  return {
    url: 'https://api.github.com/repos/o/r/x',
    fetchedAt: '2026-10-24T12:00:00.000Z',
    status,
    body,
    next: null,
  };
}
