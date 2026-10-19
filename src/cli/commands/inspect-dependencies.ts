import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { inspect } from '@/modules/inspection/inspect.js';

/**
 * Invalid configuration, inputs that no longer match the mining, or an output
 * made with other inputs throw, which the entry point turns into exit code 1.
 */
export function registerInspectDependencies(program: Command): void {
  program
    .command('inspect-dependencies')
    .description(
      'List, from the package.json of the snapshots mined by `mine`, the dependencies of the declared technologies with section, version and line, linked to the mining occurrences by unit, without interpreting them.',
    )
    .requiredOption('--config <file>', 'inspection config JSON file')
    .requiredOption('--output <directory>', 'inspection output directory')
    .action(async (options: { config: string; output: string }) => {
      const result = await inspect({
        config: JSON.parse(readFileSync(options.config, 'utf8')) as unknown,
        outputDir: options.output,
      });
      console.log(
        `${result.repositories} repositórios inspecionados em ${options.output}: ${result.dependencies} dependências, ${result.invalidManifests} manifestos inválidos.`,
      );
    });
}
