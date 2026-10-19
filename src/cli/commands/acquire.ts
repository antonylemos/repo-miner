import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { createProgress } from '@/cli/progress.js';
import { acquire } from '@/modules/acquisition/acquire.js';
import { parseAcquisitionConfig } from '@/modules/acquisition/config.js';

/**
 * `setCode` receives 0 when every selected repository has a snapshot and 2
 * when some does not (a read failure or SIGINT). Invalid configuration or
 * inputs throw, which the entry point turns into exit code 1.
 */
export function registerAcquire(
  program: Command,
  setCode: (code: number) => void,
): void {
  program
    .command('acquire')
    .description(
      'Write a normalized snapshot, pinned at the classified commit, of each annotated repository of a cloned sample.',
    )
    .requiredOption('--config <file>', 'acquisition config JSON file')
    .requiredOption('--output <directory>', 'acquisition output directory')
    .action(async (options: { config: string; output: string }) => {
      const config = parseAcquisitionConfig(
        JSON.parse(readFileSync(options.config, 'utf8')) as unknown,
      );
      const controller = new AbortController();
      const abortOnSigint = () => controller.abort();
      process.once('SIGINT', abortOnSigint);
      const progress = createProgress();
      let started = false;
      try {
        const result = await acquire({
          config,
          outputDir: options.output,
          signal: controller.signal,
          onProgress: (done, total, label) => {
            if (!started) {
              progress.start('Adquirindo', total);
              started = true;
            }
            progress.update(done, label);
          },
        });
        progress.done();
        console.log(
          `${result.acquired} de ${result.selected} repositórios adquiridos em ${options.output}/corpus (${result.written} nesta execução; ${result.unselected} anotações não selecionadas).`,
        );
        for (const repository of result.noLongerSelected)
          console.error(
            `Aviso: ${repository.fullName} (id ${repository.id}) não é mais selecionado; o snapshot continua em disco e a linha saiu do acquisition.csv.`,
          );
        for (const failure of result.failures)
          console.error(
            `Falha em ${failure.fullName} (id ${failure.id}): ${failure.error}`,
          );
        if (result.interrupted)
          console.error(
            'Interrompido; execute o acquire de novo para retomar.',
          );
        setCode(result.acquired >= result.selected ? 0 : 2);
      } finally {
        progress.done();
        process.removeListener('SIGINT', abortOnSigint);
      }
    });
}
