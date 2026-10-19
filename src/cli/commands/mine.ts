import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { mine } from '@/modules/mining/mine.js';

/**
 * Invalid configuration, a broken acquisition or an output made with another
 * configuration throw, which the entry point turns into exit code 1.
 */
export function registerMine(program: Command): void {
  program
    .command('mine')
    .description(
      'Locate, in the snapshots of an acquisition, the artifacts and pattern occurrences declared in a catalog, without interpreting them.',
    )
    .requiredOption('--config <file>', 'mining config JSON file')
    .requiredOption('--output <directory>', 'mining output directory')
    .action(async (options: { config: string; output: string }) => {
      const result = await mine({
        config: JSON.parse(readFileSync(options.config, 'utf8')) as unknown,
        outputDir: options.output,
      });
      console.log(
        `${result.repositories} repositórios minerados com ${result.patterns} padrões em ${options.output}: ${result.matches} ocorrências.`,
      );
    });
}
