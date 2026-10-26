import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { registerAcquire } from '@/cli/commands/acquire.js';
import { registerClone } from '@/cli/commands/clone.js';
import { registerDiscover } from '@/cli/commands/discover.js';
import { registerInspectDependencies } from '@/cli/commands/inspect-dependencies.js';
import { registerMine } from '@/cli/commands/mine.js';
import { registerProfile } from '@/cli/commands/profile.js';
import { registerReport } from '@/cli/commands/report.js';
import { registerSample } from '@/cli/commands/sample.js';

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
  registerDiscover(program, env, (code) => {
    actionCode = code;
  });
  registerReport(program);
  registerSample(program);
  registerClone(program, (code) => {
    actionCode = code;
  });
  registerAcquire(program, (code) => {
    actionCode = code;
  });
  registerMine(program);
  registerInspectDependencies(program);
  registerProfile(program, env);

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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
