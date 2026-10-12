import type { Command } from 'commander';
import { createProgress } from '@/cli/progress.js';
import { cloneSample } from '@/modules/sampling/clone.js';

/** `setCode` receives 0 for a complete sample and 2 when fewer than X repositories were cloned. */
export function registerClone(
  program: Command,
  setCode: (code: number) => void,
): void {
  program
    .command('clone')
    .description(
      'Clone the repositories of a sample, replacing failures with the next of the ranking.',
    )
    .requiredOption('--sample <directory>', 'sample directory made by `sample`')
    .action(async (options: { sample: string }) => {
      const controller = new AbortController();
      const abortOnSigint = () => controller.abort();
      process.once('SIGINT', abortOnSigint);
      const progress = createProgress();
      let started = false;
      try {
        const result = await cloneSample({
          directory: options.sample,
          remoteUrl: (fullName) => `https://github.com/${fullName}.git`,
          signal: controller.signal,
          onProgress: (done, total, label) => {
            if (!started) {
              progress.start('Clonando', total);
              started = true;
            }
            progress.update(done, label);
          },
        });
        progress.done();
        console.log(
          `${result.cloned} de ${result.size} repositórios clonados em ${options.sample}/repos (${result.failed} falhas nesta execução).`,
        );
        if (result.interrupted)
          console.error('Interrompido; execute o clone de novo para retomar.');
        else if (result.exhausted)
          console.error(
            'O ranking acabou antes de completar a amostra; veja o campo error de clones.csv.',
          );
        setCode(result.cloned >= result.size ? 0 : 2);
      } finally {
        progress.done();
        process.removeListener('SIGINT', abortOnSigint);
      }
    });
}
