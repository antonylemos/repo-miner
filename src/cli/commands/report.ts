import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { createProgress, type Progress } from '@/cli/progress.js';
import type { ExportProgress } from '@/modules/discovery/model/progress.js';
import { exportRun } from '@/modules/discovery/report/export.js';
import { openStore } from '@/modules/discovery/storage/store.js';
import { readStoredStudyConfig } from '@/modules/discovery/storage/stored-run.js';

export function registerReport(program: Command): void {
  program
    .command('report')
    .description('Export reports for an existing discovery run.')
    .requiredOption('--run <directory>', 'discovery run directory')
    .action(async (options: { run: string }) => {
      const databasePath = join(options.run, 'discovery.sqlite');
      if (!existsSync(databasePath)) {
        throw new Error('The run directory does not contain discovery.sqlite.');
      }
      readStoredStudyConfig(databasePath);
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
}

/** Adapts export steps to the progress bar, starting the phase on step zero. */
export function exportProgress(progress: Progress): ExportProgress {
  return (done, total, label) => {
    if (done === 0) progress.start('Exportando', total);
    progress.update(done, label);
  };
}
