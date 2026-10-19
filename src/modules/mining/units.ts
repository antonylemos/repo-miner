import { compareCodePoints } from '@/common/order.js';
import type { ArtifactFile } from './artifacts.js';

export type Unit = {
  /** `.` for the root of the snapshot. */
  directory: string;
  /** Paths of the files with a unit type that the directory contains directly. */
  markers: string[];
};

/** The directories that directly contain a file with one of `unitTypes`, ordered by path. */
export function findUnits(files: ArtifactFile[], unitTypes: string[]): Unit[] {
  const units = new Map<string, string[]>();
  for (const file of files) {
    if (!file.types.some((type) => unitTypes.includes(type))) continue;
    const slash = file.path.lastIndexOf('/');
    const directory = slash < 0 ? '.' : file.path.slice(0, slash);
    units.set(directory, [...(units.get(directory) ?? []), file.path]);
  }
  return [...units]
    .map(([directory, markers]) => ({
      directory,
      markers: markers.sort(compareCodePoints),
    }))
    .sort((a, b) => compareCodePoints(a.directory, b.directory));
}
