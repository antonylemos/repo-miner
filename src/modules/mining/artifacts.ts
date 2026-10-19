import { matchesGlob } from 'node:path';
import { listFiles, type SnapshotFile } from './source.js';

export type ArtifactFile = {
  /** Relative to the snapshot's `files/`, with `/` separators. */
  path: string;
  size: number;
  /** Every artifact type whose globs match the path, in the order of the config. */
  types: string[];
};

/** Gives each file all the artifact types whose globs match its path, and none when no glob does. */
export function assignTypes(
  files: SnapshotFile[],
  artifactTypes: Record<string, string[]>,
): ArtifactFile[] {
  const types = Object.entries(artifactTypes);
  return files.map(({ path, size }) => ({
    path,
    size,
    types: types
      .filter(([, globs]) => globs.some((glob) => matchesGlob(path, glob)))
      .map(([id]) => id),
  }));
}

/** The files of a snapshot with their artifact types, ordered by path in code points. */
export function listArtifacts(
  filesDirectory: string,
  artifactTypes: Record<string, string[]>,
): ArtifactFile[] {
  return assignTypes(listFiles(filesDirectory), artifactTypes);
}
