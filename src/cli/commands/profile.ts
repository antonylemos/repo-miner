import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { createProgress } from '@/cli/progress.js';
import { clientOptions, withInterrupt } from '@/cli/runtime.js';
import { profile } from '@/modules/profile/profile.js';

/**
 * Invalid configuration, inputs or reviews, an output made with other inputs,
 * a missing `GITHUB_TOKEN` for a page not yet kept, and API failures throw,
 * which the entry point turns into exit code 1.
 */
export function registerProfile(
  program: Command,
  env: NodeJS.ProcessEnv,
): void {
  program
    .command('profile')
    .description(
      'Measure the repositories of an acquisition at the date of their clones (files, languages, commits, stars, forks, contributors and the variables of annotations and reviews) and summarize them; GITHUB_TOKEN is needed only for API pages not yet in the output.',
    )
    .requiredOption('--config <file>', 'profile config JSON file')
    .requiredOption('--output <directory>', 'profile output directory')
    .action(async (options: { config: string; output: string }) => {
      const token = env.GITHUB_TOKEN?.trim() ?? '';
      const progress = createProgress();
      let started = false;
      try {
        const { token: _token, ...http } = clientOptions(token, progress);
        const result = await withInterrupt(token, (signal) =>
          profile({
            config: JSON.parse(readFileSync(options.config, 'utf8')) as unknown,
            outputDir: options.output,
            token,
            http,
            signal,
            onProgress: (done, total, label) => {
              if (!started) {
                progress.start('Perfilando', total);
                started = true;
              }
              progress.update(done, label);
            },
          }),
        );
        progress.done();
        for (const path of result.changedReviews)
          console.error(
            `Aviso: a revisão ${path} mudou desde a execução anterior; o perfil usa a versão atual.`,
          );
        console.log(
          `${result.repositories} repositórios perfilados em ${options.output}: ${result.fetchedPages} páginas novas da API, ${result.validationDifferences} diferenças em validation.csv.`,
        );
      } finally {
        progress.done();
      }
    });
}
