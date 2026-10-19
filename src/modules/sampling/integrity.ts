import { readFileSync } from 'node:fs';
import { sha256File } from '@/common/hash.js';
import { isRecord } from '@/common/records.js';

/** The order and the rows of a sample are only the drawn ones if the files are those `sample` wrote. */
export async function assertSampleIntact(
  manifestPath: string,
  files: string[],
): Promise<void> {
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const recorded =
    isRecord(manifest) && isRecord(manifest.sha256) ? manifest.sha256 : {};
  for (const path of files) {
    const name = path.split('/').at(-1) as string;
    const expected = recorded[name];
    if (typeof expected !== 'string')
      throw new Error(`manifest.json does not record the SHA-256 of ${name}.`);
    const actual = await sha256File(path);
    if (actual !== expected)
      throw new Error(
        `${name} changed after the sample was drawn: manifest.json records ${expected}, the file has ${actual}.`,
      );
  }
}
