import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { catalogHash, parseCatalog } from '../discovery/catalog.js';
import { createEnrichmentClient } from '../discovery/enrichment.js';
import { expandCatalog } from '../discovery/expansion.js';
import { createGitHubClient } from '../discovery/github.js';
import type { HttpClientOptions } from '../discovery/http.js';
import { type ExportProgress, exportRun } from '../discovery/report.js';
import { runDiscovery } from '../discovery/runner.js';
import type { DiscoveryStore } from '../discovery/storage.js';
import type { Catalog } from '../discovery/types.js';
import { createProgress, type Progress } from './progress.js';

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
    .option('--output <directory>', 'new run output directory')
    .option('--resume <directory>', 'resume an existing run directory')
    .option(
      '--dry-run',
      'expand the catalog and print GitHub totals without creating a run',
    )
    .action(async (options: DiscoverOptions) => {
      const command = parseDiscoverOptions(options);
      if (!env.GITHUB_TOKEN?.trim()) {
        throw new Error('GITHUB_TOKEN is required for discovery.');
      }
      actionCode = command.dryRun
        ? await dryRun(command.queries as string, env.GITHUB_TOKEN)
        : await discover(command, env.GITHUB_TOKEN);
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
      const { openStore } = await import('../discovery/storage.js');
      const store = openStore(databasePath);
      const progress = createProgress();
      try {
        await exportRun(store, options.run, exportProgress(progress));
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
};

function parseDiscoverOptions(options: DiscoverOptions): DiscoverOptions {
  if (options.dryRun) {
    if (options.output || options.resume || !options.queries) {
      throw new Error(
        '--dry-run requires --queries and cannot be combined with --output or --resume.',
      );
    }
    return options;
  }
  if (options.resume && (options.queries || options.output)) {
    throw new Error('--resume cannot be combined with --queries or --output.');
  }
  if (!options.resume && (!options.queries || !options.output)) {
    throw new Error('discover requires --queries and --output, or --resume.');
  }
  return options;
}

function readCatalog(path: string): Catalog {
  return parseCatalog(JSON.parse(readFileSync(path, 'utf8')) as unknown);
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

async function dryRun(queriesPath: string, token: string): Promise<number> {
  const subqueries = expandCatalog(readCatalog(queriesPath), today());
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
): Promise<number> {
  const outputDir = command.resume ?? (command.output as string);
  const databasePath = join(outputDir, 'discovery.sqlite');
  if (command.resume && !existsSync(databasePath)) {
    throw new Error('The resume directory does not contain discovery.sqlite.');
  }
  if (!command.resume && existsSync(databasePath)) {
    throw new Error('The output directory already contains discovery.sqlite.');
  }
  const catalog = command.resume
    ? null
    : readCatalog(command.queries as string);

  let store: DiscoveryStore | undefined;
  const progress = createProgress();
  try {
    return await withInterrupt(token, async (signal) => {
      const { openStore } = await import('../discovery/storage.js');
      if (catalog) {
        mkdirSync(outputDir, { recursive: true });
        store = openStore(databasePath);
        const startedAt = new Date().toISOString();
        const expansionDate = startedAt.slice(0, 10);
        store.createRun({
          catalog,
          hash: catalogHash(catalog),
          startedAt,
          expansionDate,
          subqueries: expandCatalog(catalog, expansionDate),
        });
      } else {
        store = openStore(databasePath);
      }

      const options = clientOptions(token, progress);
      let phase = '';
      const result = await runDiscovery({
        store,
        client: createGitHubClient(options),
        enrichmentClient: createEnrichmentClient(options),
        signal,
        now: () => new Date().toISOString(),
        onProgress: (event) => {
          if (event.phase !== phase) {
            phase = event.phase;
            progress.start(
              phase === 'search' ? 'Buscando' : 'Enriquecendo',
              event.total,
            );
          }
          progress.update(event.done, event.label);
        },
      });
      await exportRun(store, outputDir, exportProgress(progress));
      progress.done();
      console.log(`Run ${result.run.id}: ${result.run.state}`);
      return result.run.state === 'complete' ? 0 : 2;
    });
  } catch (error) {
    if (store) {
      try {
        await exportRun(store, outputDir, exportProgress(progress));
      } catch {
        // Keep the original discovery or export error for the caller.
      }
    }
    throw error;
  } finally {
    progress.done();
    store?.close();
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
