import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  type DiscoverOptions,
  hasActivityOptions,
  limitsFromFlags,
  parseDiscoverOptions,
} from '@/cli/options.js';
import { createDiscoveryProgress, createProgress } from '@/cli/progress.js';
import { clientOptions, today, withInterrupt } from '@/cli/runtime.js';
import { createActivityClient } from '@/modules/discovery/collection/activity-client.js';
import { createEnrichmentClient } from '@/modules/discovery/collection/enrichment-client.js';
import { resolveResumeLimits } from '@/modules/discovery/collection/limits.js';
import { createActivityHooks } from '@/modules/discovery/collection/scheduler.js';
import { hasEligibility } from '@/modules/discovery/eligibility/protocol.js';
import type { CollectionLimits } from '@/modules/discovery/model/collection.js';
import type { DiscoveryStore } from '@/modules/discovery/model/store.js';
import type { StudyConfig } from '@/modules/discovery/model/study.js';
import { runDiscovery } from '@/modules/discovery/pipeline/run-discovery.js';
import { exportRun } from '@/modules/discovery/report/export.js';
import { createGitHubClient } from '@/modules/discovery/search/github-client.js';
import { openStore } from '@/modules/discovery/storage/store.js';
import {
  readOriginalPageSizes,
  readStoredStudyConfig,
} from '@/modules/discovery/storage/stored-run.js';
import {
  parseStudyConfig,
  prepareSearchPlan,
} from '@/modules/discovery/study/config.js';
import { exportProgress } from './report.js';

const RESULT_CAP = 1000;

/** `setCode` receives the exit code of a completed action (2 for a partial or saturated run). */
export function registerDiscover(
  program: Command,
  env: NodeJS.ProcessEnv,
  setCode: (code: number) => void,
): void {
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
      let limits = limitsFromFlags(command);
      const config = command.resume
        ? readStoredStudyConfig(join(command.resume, 'discovery.sqlite'))
        : readStudyConfig(command);
      if (hasActivityOptions(command) && !hasEligibility(config.protocol))
        throw new Error(
          'Activity options require a protocol with eligibility rules.',
        );
      if (command.resume)
        limits = resolveResumeLimits(
          limits,
          {
            commitsPerPage: command.activityCommitsPerPage !== undefined,
            branchesPerPage: command.activityBranchesPerPage !== undefined,
          },
          readOriginalPageSizes(join(command.resume, 'discovery.sqlite')),
        );
      if (!env.GITHUB_TOKEN?.trim()) {
        throw new Error('GITHUB_TOKEN is required for discovery.');
      }
      setCode(
        command.dryRun
          ? await dryRun(config, env.GITHUB_TOKEN)
          : await discover(command, env.GITHUB_TOKEN, config, limits),
      );
    });
}

function readStudyConfig(command: DiscoverOptions): StudyConfig {
  return parseStudyConfig(
    JSON.parse(readFileSync(command.queries as string, 'utf8')) as unknown,
    command.protocol
      ? (JSON.parse(readFileSync(command.protocol, 'utf8')) as unknown)
      : undefined,
  );
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
  config: StudyConfig,
  limits: CollectionLimits,
): Promise<number> {
  const outputDir = command.resume ?? (command.output as string);
  const databasePath = join(outputDir, 'discovery.sqlite');
  if (!command.resume && existsSync(databasePath))
    throw new Error('The output directory already contains discovery.sqlite.');
  let store: DiscoveryStore | undefined;
  const progress = createProgress();
  try {
    return await withInterrupt(token, async (signal) => {
      if (command.resume) store = openStore(databasePath);
      else {
        const startedAt = new Date().toISOString();
        const expansionDate = startedAt.slice(0, 10);
        const subqueries = prepareSearchPlan(config, expansionDate);
        mkdirSync(outputDir, { recursive: true });
        store = openStore(databasePath);
        store.createRun({
          config,
          startedAt,
          expansionDate,
          subqueries,
          limits,
        });
      }
      const opened = store;
      if (command.resume) announceResume(opened);
      const options = clientOptions(token, progress);
      const result = await runDiscovery({
        store: opened,
        client: createGitHubClient(options),
        metadataClient: createEnrichmentClient(options, (targets, event) => {
          const invocation = opened.getRun().invocations.at(-1);
          if (!invocation) throw new Error('Missing active invocation');
          opened.saveMetadataAttempt(
            invocation.id,
            targets.map((target) => target.repositoryId),
            event,
          );
        }),
        makeActivityClient: (task, invocationId) =>
          createActivityClient(
            options,
            limits,
            createActivityHooks(opened, task, invocationId, limits),
          ),
        limits,
        signal,
        now: () => new Date().toISOString(),
        onProgress: createDiscoveryProgress(progress),
      });
      const { state, id } = result.run;
      await exportRun(opened, outputDir, exportProgress(progress));
      progress.done();
      console.log(`Run ${id}: ${state}`);
      return state === 'complete' ? 0 : 2;
    });
  } catch (error) {
    if (store) {
      try {
        await exportRun(store, outputDir, exportProgress(progress));
      } catch {
        /* Keep the original error. */
      }
    }
    throw error;
  } finally {
    progress.done();
    store?.close();
  }
}

/** Plain text on stderr, so logs read without a TTY show what the resume is about to do. */
function announceResume(store: DiscoveryStore): void {
  const subqueries = store
    .readCoverage()
    .filter((c) => c.state === 'pending' || c.state === 'failed').length;
  const tasks = store
    .countTasks()
    .filter((c) => ['pending', 'failed', 'limited'].includes(c.state))
    .reduce((sum, c) => sum + c.count, 0);
  console.error(
    `Retomando: ${subqueries} subconsultas e ${tasks} tarefas pendentes.`,
  );
}

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|');
}
