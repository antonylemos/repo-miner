import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { catalogHash } from '../discovery/catalog.js';
import { createActivityHooks } from '../discovery/collection.js';
import { createActivityClient } from '../discovery/collectors/github-activity.js';
import {
  type CollectionLimits,
  DEFAULT_COLLECTION_LIMITS,
} from '../discovery/collectors/types.js';
import type { StudyConfig } from '../discovery/eligibility/types.js';
import { createEnrichmentClient } from '../discovery/enrichment.js';
import { createGitHubClient } from '../discovery/github.js';
import type { HttpClientOptions } from '../discovery/http.js';
import { runProtocolDiscovery } from '../discovery/protocol-runner.js';
import { exportProtocolRun } from '../discovery/report/protocol-report.js';
import { type ExportProgress, exportRun } from '../discovery/report.js';
import { runDiscovery } from '../discovery/runner.js';
import { inspectVersion } from '../discovery/storage/connection.js';
import { openProtocolStore } from '../discovery/storage/protocol-store.js';
import { openRunStore } from '../discovery/storage/run-store.js';
import { openStore } from '../discovery/storage.js';
import {
  parseStudyConfig,
  prepareSearchPlan,
} from '../discovery/study-config.js';
import {
  createDiscoveryProgress,
  createProgress,
  type Progress,
} from './progress.js';

const RESULT_CAP = 1000;

export async function main(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let actionCode = 0;
  const program = new Command()
    .name('repo-miner')
    .description('Discover GitHub repositories from a query catalog.')
    .helpOption('-h, --help', 'display help for command')
    .exitOverride()
    .configureOutput({
      writeOut: (message) => console.log(message.trimEnd()),
      writeErr: (message) => console.error(message.trimEnd()),
      outputError: (message, write) => write(message),
    });

  program
    .command('discover')
    .description('Search GitHub, resume an existing run, or preview totals.')
    .option('--queries <file>', 'query catalog JSON file')
    .option('--protocol <file>', 'eligibility protocol JSON file (catalog v3)')
    .option(
      '--activity-max-requests <number>',
      'activity attempts per candidate/invocation (default: 20)',
    )
    .option(
      '--activity-commits-per-page <number>',
      'commits per page (default: 30)',
    )
    .option(
      '--activity-branches-per-page <number>',
      'branches per page (default: 100)',
    )
    .option(
      '--activity-max-duration-ms <number>',
      'active collection duration per candidate/invocation',
    )
    .option('--output <directory>', 'new run output directory')
    .option('--resume <directory>', 'resume an existing run directory')
    .option(
      '--dry-run',
      'expand the catalog and print GitHub totals without creating a run',
    )
    .action(async (options: DiscoverOptions) => {
      const command = parseDiscoverOptions(options);
      let limits = collectionLimits(command);
      const config = command.resume
        ? validateResume(command)
        : readStudyConfig(command);
      if (command.resume) limits = resumePaginationLimits(command, limits);
      if (config?.kind === 'legacy' && hasActivityOptions(command))
        throw new Error('Activity options require a version 3 catalog.');
      if (!env.GITHUB_TOKEN?.trim()) {
        throw new Error('GITHUB_TOKEN is required for discovery.');
      }
      actionCode = command.dryRun
        ? await dryRun(config as StudyConfig, env.GITHUB_TOKEN)
        : await discover(command, env.GITHUB_TOKEN, config, limits);
    });

  program
    .command('report')
    .description('Export reports for an existing discovery run.')
    .requiredOption('--run <directory>', 'discovery run directory')
    .action(async (options: { run: string }) => {
      const databasePath = join(options.run, 'discovery.sqlite');
      if (!existsSync(databasePath)) {
        throw new Error('The run directory does not contain discovery.sqlite.');
      }
      validateStoredRun(databasePath);
      const opened = openRunStore(databasePath);
      const store = opened.store;
      const progress = createProgress();
      try {
        await exportOpenedRun(opened, options.run, progress);
      } finally {
        progress.done();
        store.close();
      }
      console.log(`Relatório exportado em ${options.run}`);
    });

  try {
    await program.parseAsync(['node', 'repo-miner', ...args]);
    return actionCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.code === 'commander.helpDisplayed' ? 0 : 1;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

type DiscoverOptions = {
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

function parseDiscoverOptions(options: DiscoverOptions): DiscoverOptions {
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

function readStudyConfig(command: DiscoverOptions): StudyConfig {
  return parseStudyConfig(
    JSON.parse(readFileSync(command.queries as string, 'utf8')) as unknown,
    command.protocol
      ? (JSON.parse(readFileSync(command.protocol, 'utf8')) as unknown)
      : undefined,
  );
}

function hasActivityOptions(command: DiscoverOptions): boolean {
  return [
    command.activityMaxRequests,
    command.activityCommitsPerPage,
    command.activityBranchesPerPage,
    command.activityMaxDurationMs,
  ].some((value) => value !== undefined);
}

function collectionLimits(command: DiscoverOptions): CollectionLimits {
  const positive = (
    value: string | undefined,
    fallback: number,
    label: string,
    maximum = Number.MAX_SAFE_INTEGER,
  ): number => {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(number) || number <= 0 || number > maximum)
      throw new Error(`${label} must be a positive integer <= ${maximum}.`);
    return number;
  };
  return {
    maxActivityRequestsPerCandidate: positive(
      command.activityMaxRequests,
      DEFAULT_COLLECTION_LIMITS.maxActivityRequestsPerCandidate,
      '--activity-max-requests',
    ),
    commitsPerPage: positive(
      command.activityCommitsPerPage,
      DEFAULT_COLLECTION_LIMITS.commitsPerPage,
      '--activity-commits-per-page',
      100,
    ),
    branchesPerPage: positive(
      command.activityBranchesPerPage,
      DEFAULT_COLLECTION_LIMITS.branchesPerPage,
      '--activity-branches-per-page',
      100,
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

/** Validate stored policy read-only before opening a writer or making HTTP requests. */
function validateResume(command: DiscoverOptions): null {
  const path = join(command.resume as string, 'discovery.sqlite');
  const version = validateStoredRun(path);
  if (version === 2 && hasActivityOptions(command))
    throw new Error('Activity options require a schema 3 run.');
  return null;
}

/** Page numbers retain their original boundaries across all invocations. */
function resumePaginationLimits(
  command: DiscoverOptions,
  limits: CollectionLimits,
): CollectionLimits {
  const path = join(command.resume as string, 'discovery.sqlite');
  if (inspectVersion(path) !== 3) return limits;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT limits_json FROM invocations ORDER BY rowid LIMIT 1')
      .get();
    if (!row) throw new Error('Missing original collection limits.');
    const stored = JSON.parse(
      String(row.limits_json),
    ) as Partial<CollectionLimits>;
    for (const [key, option] of [
      ['commitsPerPage', 'activityCommitsPerPage'],
      ['branchesPerPage', 'activityBranchesPerPage'],
    ] as const) {
      const size = stored[key];
      if (
        typeof size !== 'number' ||
        !Number.isInteger(size) ||
        size < 1 ||
        size > 100
      )
        throw new Error('Invalid stored pagination size.');
      if (command[option] !== undefined && limits[key] !== size)
        throw new Error(`Resume must preserve the original ${key} (${size}).`);
    }
    return {
      ...limits,
      commitsPerPage: stored.commitsPerPage as number,
      branchesPerPage: stored.branchesPerPage as number,
    };
  } finally {
    db.close();
  }
}

/** Validate schema and stored protocol before opening a writable run store. */
function validateStoredRun(path: string): number {
  const version = inspectVersion(path);
  if (version !== 2 && version !== 3)
    throw new Error(
      `Unsupported discovery database schema (version ${version})`,
    );
  if (version === 3) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare('SELECT config_json FROM runs LIMIT 1').get();
      if (!row) throw new Error('No discovery run has been created');
      const config = JSON.parse(String(row.config_json)) as {
        kind?: unknown;
        catalog?: unknown;
        protocol?: unknown;
      };
      if (
        config.kind !== 'protocol' ||
        config.protocol === undefined ||
        parseStudyConfig(config.catalog, config.protocol).kind !== 'protocol'
      )
        throw new Error('Invalid stored protocol configuration');
    } finally {
      db.close();
    }
  }
  return version;
}

type OpenedRun = ReturnType<typeof openRunStore>;
async function exportOpenedRun(
  opened: OpenedRun,
  directory: string,
  progress: Progress,
): Promise<void> {
  if (opened.version === 3)
    await exportProtocolRun(opened.store, directory, exportProgress(progress));
  else await exportRun(opened.store, directory, exportProgress(progress));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function clientOptions(token: string, progress: Progress): HttpClientOptions {
  return {
    token,
    fetchFn: globalThis.fetch,
    now: Date.now,
    sleep: async (ms, signal) => {
      progress.wait(ms);
      try {
        await sleepAbortably(ms, signal);
      } finally {
        progress.wait(0);
      }
    },
  };
}

/** Runs work with a SIGINT-aware signal and redacts the token from any error. */
async function withInterrupt<T>(
  token: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortOnSigint = () =>
    controller.abort(new Error('Interrupted by SIGINT'));
  process.once('SIGINT', abortOnSigint);
  try {
    return await work(controller.signal);
  } catch (error) {
    throw new Error(redactMessage(error, token));
  } finally {
    process.removeListener('SIGINT', abortOnSigint);
  }
}

async function dryRun(config: StudyConfig, token: string): Promise<number> {
  const subqueries = prepareSearchPlan(config, today());
  const progress = createProgress();
  const client = createGitHubClient(clientOptions(token, progress));
  try {
    return await withInterrupt(token, async (signal) => {
      progress.start('Contando', subqueries.length);
      console.log(
        '| query_id | subquery_id | q_effective | total | incompleto | saturada |',
      );
      console.log('| --- | --- | --- | ---: | --- | --- |');
      let saturated = 0;
      let sum = 0;
      for (const [index, subquery] of subqueries.entries()) {
        const { totalCount, incomplete } = await client.count(subquery, signal);
        progress.update(index + 1, subquery.id);
        const over = totalCount > RESULT_CAP;
        if (over) saturated += 1;
        sum += totalCount;
        console.log(
          `| ${subquery.queryId} | ${subquery.id} | ${escapeCell(subquery.q)} | ${totalCount} | ${incomplete ? 'sim' : 'não'} | ${over ? '**sim**' : ''} |`,
        );
      }
      progress.done();
      console.log(
        `\nSubconsultas: ${subqueries.length}. Saturadas: ${saturated}. Soma dos totais: ${sum}.`,
      );
      return saturated > 0 ? 2 : 0;
    });
  } finally {
    progress.done();
  }
}

async function discover(
  command: DiscoverOptions,
  token: string,
  config: StudyConfig | null,
  limits: CollectionLimits,
): Promise<number> {
  const outputDir = command.resume ?? (command.output as string);
  const databasePath = join(outputDir, 'discovery.sqlite');
  if (!command.resume && existsSync(databasePath))
    throw new Error('The output directory already contains discovery.sqlite.');
  let opened: OpenedRun | undefined;
  const progress = createProgress();
  try {
    return await withInterrupt(token, async (signal) => {
      if (config) {
        const startedAt = new Date().toISOString();
        const expansionDate = startedAt.slice(0, 10);
        const subqueries = prepareSearchPlan(config, expansionDate);
        mkdirSync(outputDir, { recursive: true });
        if (config.kind === 'protocol') {
          const store = openProtocolStore(databasePath);
          opened = { version: 3, store };
          store.createRun({
            config,
            startedAt,
            expansionDate,
            subqueries,
            limits,
          });
        } else {
          const store = openStore(databasePath);
          opened = { version: 2, store };
          store.createRun({
            catalog: config.catalog,
            hash: catalogHash(config.catalog),
            startedAt,
            expansionDate,
            subqueries,
          });
        }
      } else opened = openRunStore(databasePath);
      const options = clientOptions(token, progress);
      const onProgress = createDiscoveryProgress(progress);
      let state: string;
      let id: string;
      if (opened.version === 3) {
        const store = opened.store;
        const result = await runProtocolDiscovery({
          store,
          client: createGitHubClient(options),
          metadataClient: createEnrichmentClient(
            options,
            'facts',
            (targets, event) => {
              const invocation = store.getRun().invocations.at(-1);
              if (!invocation) throw new Error('Missing active invocation');
              store.saveMetadataAttempt(
                invocation.id,
                targets.map((target) => target.repositoryId),
                event,
              );
            },
          ),
          makeActivityClient: (task, invocationId) =>
            createActivityClient(
              options,
              limits,
              createActivityHooks(store, task, invocationId, limits),
            ),
          limits,
          signal,
          now: () => new Date().toISOString(),
          onProgress,
        });
        ({ state, id } = result.run);
      } else {
        const result = await runDiscovery({
          store: opened.store,
          client: createGitHubClient(options),
          enrichmentClient: createEnrichmentClient(options),
          signal,
          now: () => new Date().toISOString(),
          onProgress,
        });
        ({ state, id } = result.run);
      }
      await exportOpenedRun(opened, outputDir, progress);
      progress.done();
      console.log(`Run ${id}: ${state}`);
      return state === 'complete' ? 0 : 2;
    });
  } catch (error) {
    if (opened) {
      try {
        await exportOpenedRun(opened, outputDir, progress);
      } catch {
        /* Keep the original error. */
      }
    }
    throw error;
  } finally {
    progress.done();
    opened?.store.close();
  }
}

/** Adapts export steps to the progress bar, starting the phase on step zero. */
function exportProgress(progress: Progress): ExportProgress {
  return (done, total, label) => {
    if (done === 0) progress.start('Exportando', total);
    progress.update(done, label);
  };
}

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|');
}

function sleepAbortably(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal.aborted) {
      rejectSleep(signal.reason ?? new Error('Request aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolveSleep();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      rejectSleep(signal.reason ?? new Error('Request aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function redactMessage(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return token.length > 0 ? message.split(token).join('[REDACTED]') : message;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
