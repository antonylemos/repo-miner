import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from '@/common/command.js';
import { readCsvRecords } from '@/common/csv.js';
import { isRecord } from '@/common/records.js';
import { readSource, type SourceRepository } from '@/modules/mining/source.js';
import type { ProfileConfig } from './config.js';
import { hasCommit } from './history.js';

export type ProfileRepository = SourceRepository & {
  commitSha: string;
  /** `attempted_at` of the clone, the instant every measure refers to. */
  referenceAt: string;
  /** Directory of the repository's clone. */
  clone: string;
  /** The row of `acquisition.csv`. */
  row: Record<string, string>;
};

export type ProfileInputs = {
  acquisitionDirectory: string;
  acquisitionManifestSha256: string;
  sampleDirectory: string;
  /** In the order of `acquisition.csv`. */
  repositories: ProfileRepository[];
};

function inputsError(problems: string[]): Error {
  return new Error(
    `The profile inputs have ${problems.length} problem${problems.length === 1 ? '' : 's'}; nothing was written:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  );
}

function sampleOf(directory: string): string {
  const path = join(directory, 'manifest.json');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw inputsError([`${path} is not valid JSON.`]);
  }
  const config = isRecord(value) ? value.config : null;
  if (!isRecord(config) || typeof config.sample !== 'string')
    throw inputsError([`${path} does not record the sample directory.`]);
  return config.sample;
}

/**
 * Reads the acquisition and the sample it records, and checks that every
 * repository has a `cloned` row in `clones.csv` with the commit of its
 * snapshot, and a clone that has that commit. All problems are collected before
 * failing.
 */
export async function readInputs(
  config: ProfileConfig,
  run: CommandRunner,
): Promise<ProfileInputs> {
  const source = await readSource(config.acquisition);
  const sampleDirectory = sampleOf(config.acquisition);
  const clonesPath = join(sampleDirectory, 'clones.csv');
  if (!existsSync(clonesPath))
    throw inputsError([`${clonesPath} does not exist.`]);
  const rows = await readCsvRecords(
    join(config.acquisition, 'acquisition.csv'),
    ['commit_sha'],
  );
  const clones = new Map<string, Record<string, string>>();
  for (const row of await readCsvRecords(clonesPath, [
    'id',
    'status',
    'commit_sha',
    'attempted_at',
  ]))
    if (row.status === 'cloned') clones.set(row.id as string, row);

  const problems: string[] = [];
  const repositories: ProfileRepository[] = [];
  for (const [index, repository] of source.repositories.entries()) {
    const row = rows[index] as Record<string, string>;
    const commitSha = row.commit_sha as string;
    const cloned = clones.get(repository.id);
    if (cloned === undefined) {
      problems.push(
        `${repository.fullName}: ${clonesPath} has no cloned row for the repository.`,
      );
      continue;
    }
    if (cloned.commit_sha !== commitSha) {
      problems.push(
        `${repository.fullName}: clones.csv has commit_sha ${cloned.commit_sha}, but acquisition.csv has ${commitSha}.`,
      );
      continue;
    }
    const referenceAt = cloned.attempted_at as string;
    if (Number.isNaN(Date.parse(referenceAt))) {
      problems.push(
        `${repository.fullName}: clones.csv has the invalid attempted_at ${referenceAt}.`,
      );
      continue;
    }
    const clone = join(sampleDirectory, 'repos', repository.directoryName);
    if (!existsSync(clone)) {
      problems.push(
        `${repository.fullName}: the clone ${clone} does not exist.`,
      );
      continue;
    }
    if (!(await hasCommit(run, clone, commitSha))) {
      problems.push(
        `${repository.fullName}: the clone ${clone} does not have the commit ${commitSha}.`,
      );
      continue;
    }
    repositories.push({ ...repository, commitSha, referenceAt, clone, row });
  }
  if (problems.length > 0) throw inputsError(problems);

  return {
    acquisitionDirectory: config.acquisition,
    acquisitionManifestSha256: source.manifestSha256,
    sampleDirectory,
    repositories,
  };
}
