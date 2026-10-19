import { existsSync, renameSync, rmSync } from 'node:fs';

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
