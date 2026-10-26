import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Replaces `outputDir` by `partial`, keeping the previous output until the new one is in place. */
export function replaceOutput(partial: string, outputDir: string): void {
  const previous = `${outputDir}.previous`;
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(outputDir)) renameSync(outputDir, previous);
  try {
    renameSync(partial, outputDir);
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, outputDir);
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
}

/**
 * Puts the files `names` of `staging` in `outputDir`, leaving the rest of
 * `outputDir` alone. The files that were there stay in `<outputDir>/.previous`
 * until all the new ones are in place, and come back if any step fails.
 */
export function replaceFiles(
  staging: string,
  outputDir: string,
  names: string[],
): void {
  const previous = join(outputDir, '.previous');
  rmSync(previous, { recursive: true, force: true });
  mkdirSync(previous, { recursive: true });
  const moved: string[] = [];
  const placed: string[] = [];
  try {
    for (const name of names)
      if (existsSync(join(outputDir, name))) {
        renameSync(join(outputDir, name), join(previous, name));
        moved.push(name);
      }
    for (const name of names) {
      renameSync(join(staging, name), join(outputDir, name));
      placed.push(name);
    }
  } catch (error) {
    for (const name of placed) rmSync(join(outputDir, name), { force: true });
    for (const name of moved)
      renameSync(join(previous, name), join(outputDir, name));
    rmSync(previous, { recursive: true, force: true });
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
}
