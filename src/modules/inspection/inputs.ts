import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCsvRecords } from '@/common/csv.js';
import { sha256File } from '@/common/hash.js';
import { isRecord } from '@/common/records.js';
import {
  type AcquisitionSource,
  readSource,
  type SourceRepository,
} from '@/modules/mining/source.js';
import { directoryName } from '@/modules/sampling/clone.js';
import type { InspectionConfig } from './config.js';

export type MiningMatch = {
  pattern: string;
  path: string;
  /** Empty for an occurrence without a line. */
  line: string;
};

export type InspectionRepository = SourceRepository & {
  matches: MiningMatch[];
};

export type InspectionInputs = {
  miningDirectory: string;
  miningManifestSha256: string;
  /** In the order of the acquisition's `acquisition.csv`. */
  repositories: InspectionRepository[];
};

type MiningManifest = {
  acquisitionDirectory: string;
  acquisitionManifestSha256: string;
  acquisitionSha256: string;
  snapshots: Record<string, string>;
  patternIds: string[];
};

const MANIFEST_FILE = 'manifest.json';

function readMiningManifest(path: string): MiningManifest | string {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return `${path} is not valid JSON.`;
  }
  const config = isRecord(value) ? value.config : null;
  const acquisition = isRecord(value) ? value.acquisition : null;
  const snapshots = isRecord(value) ? value.snapshots : null;
  if (
    !isRecord(acquisition) ||
    typeof acquisition.directory !== 'string' ||
    typeof acquisition.manifestSha256 !== 'string' ||
    typeof acquisition.acquisitionSha256 !== 'string' ||
    !isRecord(snapshots) ||
    !isRecord(config) ||
    !Array.isArray(config.patterns)
  )
    return `${path} is not a mining manifest.`;
  return {
    acquisitionDirectory: acquisition.directory,
    acquisitionManifestSha256: acquisition.manifestSha256,
    acquisitionSha256: acquisition.acquisitionSha256,
    snapshots: Object.fromEntries(
      Object.entries(snapshots).map(([name, sha]) => [name, String(sha)]),
    ),
    patternIds: config.patterns
      .map((pattern) => (isRecord(pattern) ? pattern.id : null))
      .filter((id): id is string => typeof id === 'string'),
  };
}

function inputsError(problems: string[]): Error {
  return new Error(
    `The inspection inputs have ${problems.length} problem${problems.length === 1 ? '' : 's'}; nothing was written:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  );
}

/**
 * Reads the mining output and the acquisition it was made from, and checks
 * that the acquisition still has the hashes the mining recorded and that every
 * pattern the technologies name exists in the mining catalog. All problems are
 * collected before failing.
 */
export async function readInputs(
  config: InspectionConfig,
): Promise<InspectionInputs> {
  const manifestPath = join(config.mining, MANIFEST_FILE);
  if (!existsSync(manifestPath))
    throw inputsError([`${manifestPath} does not exist.`]);
  const manifest = readMiningManifest(manifestPath);
  if (typeof manifest === 'string') throw inputsError([manifest]);

  const problems: string[] = [];
  for (const technology of config.technologies)
    for (const pattern of technology.patterns)
      if (!manifest.patternIds.includes(pattern))
        problems.push(
          `Technology ${technology.id} uses the pattern ${pattern}, which is not in the mining catalog.`,
        );

  let source: AcquisitionSource | null = null;
  try {
    source = await readSource(manifest.acquisitionDirectory);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  const repositories: InspectionRepository[] = [];
  if (source !== null) {
    if (source.manifestSha256 !== manifest.acquisitionManifestSha256)
      problems.push(
        `${manifest.acquisitionDirectory}/manifest.json has SHA-256 ${source.manifestSha256}, but the mining recorded ${manifest.acquisitionManifestSha256}.`,
      );
    if (source.acquisitionSha256 !== manifest.acquisitionSha256)
      problems.push(
        `${manifest.acquisitionDirectory}/acquisition.csv has SHA-256 ${source.acquisitionSha256}, but the mining recorded ${manifest.acquisitionSha256}.`,
      );
    for (const repository of source.repositories) {
      const recorded = manifest.snapshots[repository.fullName];
      if (recorded !== repository.contentSha256)
        problems.push(
          `${repository.fullName}: the snapshot has content_sha256 ${repository.contentSha256}, but the mining recorded ${recorded ?? 'none'}.`,
        );
    }
    const known = new Set(
      source.repositories.map((repository) => repository.fullName),
    );
    for (const fullName of Object.keys(manifest.snapshots))
      if (!known.has(fullName))
        problems.push(
          `${fullName}: the mining recorded a snapshot that the acquisition does not have.`,
        );
  }

  // Without a readable acquisition, the repositories are those the mining recorded.
  const names =
    source?.repositories.map((repository) => repository.fullName) ??
    Object.keys(manifest.snapshots);
  for (const [index, fullName] of names.entries()) {
    const directory = join(config.mining, 'repos', directoryName(fullName));
    const matchesPath = join(directory, 'matches.csv');
    if (!existsSync(matchesPath)) {
      problems.push(`${matchesPath} does not exist.`);
      continue;
    }
    const repository = source?.repositories[index];
    if (repository === undefined) continue;
    const matches = await readCsvRecords(matchesPath, [
      'pattern',
      'path',
      'line',
    ]);
    repositories.push({
      ...repository,
      matches: matches.map((match) => ({
        pattern: match.pattern as string,
        path: match.path as string,
        line: match.line as string,
      })),
    });
  }
  if (problems.length > 0) throw inputsError(problems);

  return {
    miningDirectory: config.mining,
    miningManifestSha256: await sha256File(manifestPath),
    repositories,
  };
}
