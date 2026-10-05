import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { catalogHash, parseCatalog } from '../discovery/catalog.js';
import { createGitHubClient } from '../discovery/github.js';
import { exportRun } from '../discovery/report.js';
import { runDiscovery } from '../discovery/runner.js';
import type { DiscoveryStore } from '../discovery/storage.js';
import type { Catalog } from '../discovery/types.js';

export async function main(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let actionCode = 0;
  const program = new Command()
    .name('repo-discovery')
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
    .description('Search GitHub or resume an existing discovery run.')
    .option('--queries <file>', 'query catalog JSON file')
    .option('--output <directory>', 'new run output directory')
    .option('--resume <directory>', 'resume an existing run directory')
    .action(async (options: DiscoverOptions) => {
      const command = parseDiscoverOptions(options);
      if (!env.GITHUB_TOKEN?.trim()) {
        throw new Error('GITHUB_TOKEN is required for discovery.');
      }
      actionCode = await discover(command, env.GITHUB_TOKEN);
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
      try {
        await exportRun(store, options.run);
      } finally {
        store.close();
      }
    });

  try {
    await program.parseAsync(['node', 'repo-discovery', ...args]);
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
};

type DiscoverCommand = {
  queries?: string;
  output?: string;
  resume?: string;
};

function parseDiscoverOptions(options: DiscoverOptions): DiscoverCommand {
  if (options.resume && (options.queries || options.output)) {
    throw new Error('--resume cannot be combined with --queries or --output.');
  }
  if (!options.resume && (!options.queries || !options.output)) {
    throw new Error('discover requires --queries and --output, or --resume.');
  }
  return options;
}

async function discover(
  command: DiscoverCommand,
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

  let store: DiscoveryStore | undefined;
  const controller = new AbortController();
  const abortOnSigint = () =>
    controller.abort(new Error('Interrupted by SIGINT'));
  process.once('SIGINT', abortOnSigint);
  try {
    const { openStore } = await import('../discovery/storage.js');
    let catalog: Catalog;
    if (command.resume) {
      store = openStore(databasePath);
      catalog = store.getCatalog();
    } else {
      const queryFile = readFileSync(command.queries as string, 'utf8');
      catalog = parseCatalog(JSON.parse(queryFile) as unknown);
      mkdirSync(outputDir, { recursive: true });
      store = openStore(databasePath);
      store.createRun(catalog, catalogHash(catalog), new Date().toISOString());
    }

    const now = () => new Date().toISOString();
    const client = createGitHubClient({
      token,
      fetchFn: globalThis.fetch,
      now: Date.now,
      sleep: sleepAbortably,
    });
    const result = await runDiscovery({
      catalog,
      store,
      client,
      signal: controller.signal,
      now,
    });
    await exportRun(store, outputDir);
    console.log(`Run ${result.run.id}: ${result.run.state}`);
    return result.run.state === 'complete' ? 0 : 2;
  } catch (error) {
    if (store) {
      try {
        await exportRun(store, outputDir);
      } catch {
        // Keep the original discovery or export error for the caller.
      }
    }
    throw new Error(redactMessage(error, token));
  } finally {
    process.removeListener('SIGINT', abortOnSigint);
    store?.close();
  }
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
