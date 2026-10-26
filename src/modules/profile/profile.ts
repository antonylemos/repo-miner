import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@/common/canonical-json.js';
import { type CommandRunner, runCommand } from '@/common/command.js';
import { writeCsv } from '@/common/csv.js';
import { replaceFiles } from '@/common/output.js';
import { isRecord } from '@/common/records.js';
import type { HttpClientOptions } from '@/modules/discovery/http/client.js';
import { annotationColumns, readAnnotationVariables } from './annotations.js';
import { type CachedPage, createApiCache } from './api-cache.js';
import { FIXED_COLUMNS, parseProfileConfig } from './config.js';
import { countContributors } from './contributors.js';
import { addDerived } from './derived.js';
import { readHistory, wholeDays } from './history.js';
import { type ProfileRepository, readInputs } from './inputs.js';
import { formatShare, measureLanguages } from './languages.js';
import { countForks, readCreatedAt, readStarCount } from './popularity.js';
import { renderReport } from './report.js';
import { readReviews } from './reviews.js';
import { summarize } from './statistics.js';
import {
  compareWithDiscovery,
  readDiscoveryObservations,
  VALIDATION_COLUMNS,
  type ValidationRow,
} from './validation.js';

export type ProfileOptions = {
  /** The parsed JSON of the config file. */
  config: unknown;
  outputDir: string;
  /** `GITHUB_TOKEN`; needed only for the API pages not yet in `<outputDir>/api`. */
  token?: string;
  http: Omit<HttpClientOptions, 'token'>;
  run?: CommandRunner;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, label: string) => void;
};

export type ProfileResult = {
  repositories: number;
  /** API pages fetched in this run. */
  fetchedPages: number;
  /** Rows of `validation.csv` whose difference is not 0. */
  validationDifferences: number;
  /** Review files whose content changed since the previous run. */
  changedReviews: string[];
};

type PreviousManifest = {
  configSha256: string;
  acquisitionManifestSha256: string;
  reviews: Record<string, string>;
};

type Measures = {
  /** Status of `GET /repos/{owner}/{name}`: 200, or the 404 or 451 that left the other measures empty. */
  status: number;
  createdAt: string | null;
  stars: number | null;
  /** When the star count was fetched. */
  starsObservedAt: string | null;
  forks: number | null;
  contributors: number | null;
  validation: ValidationRow[];
};

const API_ROOT = 'https://api.github.com/repos';
const UNAVAILABLE = [404, 451];
const DERIVED_FILES = [
  'profile.csv',
  'languages.csv',
  'validation.csv',
  'report.md',
  'manifest.json',
];
/** What a failed first run may leave in an output that has no manifest yet. */
const LEFTOVERS = ['api', '.staging', '.previous'];
const LANGUAGE_COLUMNS = [
  'id',
  'full_name',
  'language',
  'group',
  'files',
  'bytes',
  'share',
];
/** Columns that identify or date a repository; they have no distribution to report. */
const UNSUMMARIZED = [
  'id',
  'full_name',
  'commit_sha',
  'reference_at',
  'last_commit_at',
  'created_at',
  'stars_observed_at',
];

function readPrevious(outputDir: string): PreviousManifest | null {
  const path = join(outputDir, 'manifest.json');
  if (!existsSync(path)) {
    if (
      existsSync(outputDir) &&
      readdirSync(outputDir).some((name) => !LEFTOVERS.includes(name))
    )
      throw new Error(
        `${outputDir} is not empty and has no manifest.json from a previous profile; use another output directory.`,
      );
    return null;
  }
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const acquisition = isRecord(value) ? value.acquisition : null;
  if (
    !isRecord(value) ||
    typeof value.configSha256 !== 'string' ||
    !isRecord(acquisition) ||
    typeof acquisition.manifestSha256 !== 'string' ||
    !isRecord(value.reviews)
  )
    throw new Error(`${path} is not a profile manifest.`);
  return {
    configSha256: value.configSha256,
    acquisitionManifestSha256: acquisition.manifestSha256,
    reviews: value.reviews as Record<string, string>,
  };
}

/**
 * The measures that come from the GitHub API, read from the cache or fetched.
 * The repository's own answer says whether it is available; after that, each
 * measure depends only on its endpoint, so an endpoint that answers 404 or 451
 * leaves just its measure empty.
 */
async function measureApi(
  repository: ProfileRepository,
  cloneCommits: number,
  cache: ReturnType<typeof createApiCache>,
  observations: Awaited<ReturnType<typeof readDiscoveryObservations>> | null,
): Promise<Measures> {
  const base = `${API_ROOT}/${repository.fullName}`;
  const collect = (endpoint: string, url: string) =>
    cache.collect({ repository: repository.directoryName, endpoint, url });

  const details = await collect('repository', base);
  if (UNAVAILABLE.includes(details.status))
    return {
      status: details.status,
      createdAt: null,
      stars: null,
      starsObservedAt: null,
      forks: null,
      contributors: null,
      validation: [],
    };
  const stars = await collect('stargazers-count', `${base}/stargazers/count`);
  const forks = await collect(
    'forks',
    `${base}/forks?per_page=100&sort=oldest`,
  );
  const commits = await collect(
    'commits',
    `${base}/commits?sha=${repository.commitSha}&per_page=100`,
  );

  const starPage = stars.status === 200 ? (stars.pages[0] as CachedPage) : null;
  const starCount = starPage === null ? null : readStarCount(starPage);
  const forkPages = forks.status === 200 ? forks.pages : null;
  const counted =
    commits.status === 200 ? countContributors(commits.pages) : null;
  return {
    status: 200,
    createdAt: readCreatedAt(details.pages[0] as CachedPage),
    stars: starCount,
    starsObservedAt: starPage?.fetchedAt ?? null,
    forks:
      forkPages === null ? null : countForks(forkPages, repository.referenceAt),
    contributors: counted?.contributors ?? null,
    validation: compareWithDiscovery({
      id: repository.id,
      fullName: repository.fullName,
      observations: observations?.get(repository.id) ?? [],
      starCount,
      forks: forkPages,
      apiCommits: counted?.commits ?? null,
      cloneCommits,
      referenceAt: repository.referenceAt,
    }),
  };
}

const text = (value: number | string | null) => value ?? '';

/**
 * Measures each repository of an acquisition at the date of its clone: the
 * snapshot's files and languages, the clone's history, stars, forks and
 * contributors rebuilt from the GitHub API, and the variables read from the
 * acquisition and from the reviews. Writes the CSV files and the statistical
 * report to `outputDir`. The API pages are kept in `outputDir/api`, so a rerun
 * needs no network and no token; the derived files replace the previous ones
 * together, and the clones, the acquisition and the reviews are only read.
 */
export async function profile(options: ProfileOptions): Promise<ProfileResult> {
  const config = parseProfileConfig(options.config);
  const configSha256 = createHash('sha256')
    .update(canonicalJson(options.config))
    .digest('hex');
  const run = options.run ?? runCommand;
  const inputs = await readInputs(config, run);

  const previous = readPrevious(options.outputDir);
  if (
    previous !== null &&
    (previous.configSha256 !== configSha256 ||
      previous.acquisitionManifestSha256 !== inputs.acquisitionManifestSha256)
  )
    throw new Error(
      `${options.outputDir} was made with another configuration or acquisition (manifest.json records config ${previous.configSha256} and acquisition manifest ${previous.acquisitionManifestSha256}; this run has config ${configSha256} and acquisition manifest ${inputs.acquisitionManifestSha256}); use another output directory.`,
    );

  const repositories = inputs.repositories;
  const reviews = await readReviews(
    config.reviews,
    repositories.map((repository) => ({
      fullName: repository.fullName,
      commitSha: repository.commitSha,
    })),
  );
  const observations =
    config.validation === null
      ? null
      : await readDiscoveryObservations(
          config.validation.discovery,
          new Set(repositories.map((repository) => repository.id)),
        );

  // Everything that does not need the network is checked before any request.
  const local = [];
  for (const repository of repositories) {
    const languages = measureLanguages(
      repository.filesDirectory,
      config.languages,
    );
    const history = await readHistory(
      run,
      repository.clone,
      repository.commitSha,
    );
    const variables = addDerived(
      {
        ...readAnnotationVariables(repository.row, config.annotations),
        ...(reviews.values.get(repository.fullName) as Record<string, string>),
      },
      config.derived,
      repository.fullName,
    );
    local.push({ languages, history, variables });
  }

  mkdirSync(options.outputDir, { recursive: true });
  const cache = createApiCache({
    directory: join(options.outputDir, 'api'),
    token: options.token,
    http: options.http,
    signal: options.signal,
  });

  const variableNames = [
    ...annotationColumns(config.annotations),
    ...config.reviews.map((review) => review.name),
    ...config.derived.map((derived) => derived.name),
  ];
  const columns = [...FIXED_COLUMNS, ...variableNames];
  const rows: string[][] = [];
  const languageRows: unknown[][] = [];
  const validation: ValidationRow[] = [];
  let unavailable = 0;
  for (const [index, repository] of repositories.entries()) {
    options.onProgress?.(index, repositories.length, repository.fullName);
    const { languages, history, variables } = local[
      index
    ] as (typeof local)[number];
    const api = await measureApi(
      repository,
      history.commits,
      cache,
      observations,
    );
    validation.push(...api.validation);
    unavailable += api.status === 200 ? 0 : 1;
    for (const row of languages.rows)
      languageRows.push([
        repository.id,
        repository.fullName,
        row.language,
        row.group,
        row.files,
        row.bytes,
        formatShare(row.share),
      ]);
    rows.push(
      [
        repository.id,
        repository.fullName,
        repository.commitSha,
        repository.referenceAt,
        languages.files,
        languages.excludedFiles,
        languages.dominantLanguage,
        formatShare(languages.frontendShare),
        history.commits,
        history.lastCommitAt,
        wholeDays(history.lastCommitAt, repository.referenceAt),
        api.createdAt,
        api.createdAt === null
          ? null
          : wholeDays(api.createdAt, repository.referenceAt),
        api.stars,
        api.starsObservedAt,
        api.forks,
        api.contributors,
        api.status,
        ...variableNames.map((name) => variables[name] ?? ''),
      ].map((value) => String(text(value))),
    );
  }
  options.onProgress?.(repositories.length, repositories.length, '');
  if (repositories.length > 0 && unavailable === repositories.length)
    throw new Error(
      `The API answered 404 or 451 for the repository itself in all ${repositories.length} repositories, which points to the token or the API, not to deleted repositories; nothing was written. Check GITHUB_TOKEN, and remove ${join(options.outputDir, 'api')} before running again, since the answers were kept.`,
    );

  const references = repositories
    .map((repository) => repository.referenceAt)
    .sort();
  const summaries = columns
    .map((name, column) => ({ name, column }))
    .filter(({ name }) => !UNSUMMARIZED.includes(name))
    .map(({ name, column }) =>
      summarize(
        name,
        rows.map((row) => row[column] as string),
      ),
    );

  const staging = join(options.outputDir, '.staging');
  rmSync(staging, { recursive: true, force: true });
  try {
    mkdirSync(staging);
    await writeCsv(join(staging, 'profile.csv'), columns, rows);
    await writeCsv(
      join(staging, 'languages.csv'),
      LANGUAGE_COLUMNS,
      languageRows,
    );
    await writeCsv(
      join(staging, 'validation.csv'),
      VALIDATION_COLUMNS,
      validation.map((row) => [
        row.id,
        row.fullName,
        row.measure,
        row.at,
        row.reconstructed,
        row.recorded,
        row.difference,
      ]),
    );
    writeFileSync(
      join(staging, 'report.md'),
      renderReport({
        version: config.version,
        repositories: repositories.length,
        acquisition: inputs.acquisitionDirectory,
        referenceFrom: references[0] ?? '',
        referenceTo: references.at(-1) ?? '',
        summaries,
      }),
    );
    writeFileSync(
      join(staging, 'manifest.json'),
      `${JSON.stringify(
        {
          schema: 1,
          version: config.version,
          configSha256,
          config: options.config,
          acquisition: {
            directory: inputs.acquisitionDirectory,
            manifestSha256: inputs.acquisitionManifestSha256,
          },
          reviews: reviews.files,
        },
        null,
        2,
      )}\n`,
    );
    replaceFiles(staging, options.outputDir, DERIVED_FILES);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return {
    repositories: repositories.length,
    fetchedPages: cache.fetchedPages(),
    validationDifferences: validation.filter((row) => row.difference !== 0)
      .length,
    changedReviews:
      previous === null
        ? []
        : Object.entries(reviews.files)
            .filter(([path, sha]) => previous.reviews[path] !== sha)
            .map(([path]) => path),
  };
}
