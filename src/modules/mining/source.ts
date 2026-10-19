import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readCsvRecords } from '@/common/csv.js';
import { sha256File } from '@/common/hash.js';
import { compareCodePoints } from '@/common/order.js';
import { isRecord } from '@/common/records.js';
import { contentHash } from '@/modules/acquisition/content-hash.js';
import {
  FILES_DIRECTORY,
  NORMALIZATION_FILE,
} from '@/modules/acquisition/snapshot.js';
import { directoryName } from '@/modules/sampling/clone.js';

export type SnapshotFile = {
  /** Relative to the snapshot's `files/`, with `/` separators. */
  path: string;
  size: number;
  executable: boolean;
};

export type SourceRepository = {
  id: string;
  fullName: string;
  /** `<owner>__<name>`. */
  directoryName: string;
  /** Absolute or working-directory-relative path of the snapshot's `files/`. */
  filesDirectory: string;
  contentSha256: string;
};

export type AcquisitionSource = {
  directory: string;
  manifestSha256: string;
  acquisitionSha256: string;
  /** In the order of `acquisition.csv`. */
  repositories: SourceRepository[];
};

const MANIFEST_FILE = 'manifest.json';
const ACQUISITION_FILE = 'acquisition.csv';
const CORPUS_DIRECTORY = 'corpus';

/** Lists the files below `directory`, ordered by path in code points. */
export function listFiles(directory: string): SnapshotFile[] {
  const found: SnapshotFile[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) walk(absolute, path);
      else if (entry.isFile()) {
        const stats = statSync(absolute);
        found.push({
          path,
          size: stats.size,
          executable: (stats.mode & 0o111) !== 0,
        });
      }
    }
  };
  walk(directory, '');
  return found.sort((a, b) => compareCodePoints(a.path, b.path));
}

async function recomputeHash(filesDirectory: string): Promise<string> {
  const entries = await Promise.all(
    listFiles(filesDirectory).map(async (file) => ({
      path: file.path,
      mode: file.executable ? '100755' : '100644',
      sha256: await sha256File(join(filesDirectory, file.path)),
    })),
  );
  return contentHash(entries);
}

function recordedHash(directory: string): string | null {
  const path = join(directory, NORMALIZATION_FILE);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(value) && typeof value.contentSha256 === 'string'
      ? value.contentSha256
      : null;
  } catch {
    return null;
  }
}

/**
 * Reads the acquisition and checks every snapshot against the hashes recorded
 * in `acquisition.csv` and `normalization.json`. All problems are collected
 * before failing.
 */
export async function readSource(
  directory: string,
): Promise<AcquisitionSource> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const acquisitionPath = join(directory, ACQUISITION_FILE);
  const problems: string[] = [];
  for (const path of [manifestPath, acquisitionPath])
    if (!existsSync(path)) problems.push(`${path} does not exist.`);
  if (problems.length > 0) throw sourceError(problems);

  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!isRecord(manifest)) problems.push(`${manifestPath} is not an object.`);
  } catch {
    problems.push(`${manifestPath} is not valid JSON.`);
  }

  const rows = await readCsvRecords(acquisitionPath, [
    'id',
    'full_name',
    'content_sha256',
  ]);
  const repositories: SourceRepository[] = [];
  for (const row of rows) {
    const name = directoryName(row.full_name as string);
    const snapshot = join(directory, CORPUS_DIRECTORY, name);
    const filesDirectory = join(snapshot, FILES_DIRECTORY);
    const expected = row.content_sha256 as string;
    repositories.push({
      id: row.id as string,
      fullName: row.full_name as string,
      directoryName: name,
      filesDirectory,
      contentSha256: expected,
    });
    if (!existsSync(filesDirectory)) {
      problems.push(
        `${row.full_name}: the snapshot ${snapshot} does not exist.`,
      );
      continue;
    }
    const recorded = recordedHash(snapshot);
    const actual = await recomputeHash(filesDirectory);
    if (recorded !== expected || actual !== expected)
      problems.push(
        `${row.full_name}: acquisition.csv has content_sha256 ${expected}, ${NORMALIZATION_FILE} has ${recorded ?? 'none'} and the files hash to ${actual}.`,
      );
  }
  if (problems.length > 0) throw sourceError(problems);

  return {
    directory,
    manifestSha256: await sha256File(manifestPath),
    acquisitionSha256: await sha256File(acquisitionPath),
    repositories,
  };
}

function sourceError(problems: string[]): Error {
  return new Error(
    `The acquisition has ${problems.length} problem${problems.length === 1 ? '' : 's'}; nothing was written:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  );
}
