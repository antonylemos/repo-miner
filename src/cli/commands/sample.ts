import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { parseSamplingConfig } from '@/modules/sampling/config.js';
import { createSample } from '@/modules/sampling/sample.js';

export function registerSample(program: Command): void {
  program
    .command('sample')
    .description(
      'Draw a reproducible random sample from an exported discovery round.',
    )
    .requiredOption('--config <file>', 'sample config JSON file')
    .requiredOption('--output <directory>', 'new sample output directory')
    .action(async (options: { config: string; output: string }) => {
      const config = parseSamplingConfig(
        JSON.parse(readFileSync(options.config, 'utf8')) as unknown,
      );
      const result = await createSample(config, options.output);
      console.log(
        `Amostra de ${result.size} repositórios sorteada de uma população de ${result.population} (${result.excluded} excluídos pelo filtro). Arquivos em ${result.outputDir}`,
      );
    });
}
