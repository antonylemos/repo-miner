import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256File } from '@/common/hash.js';
import { assertSampleIntact } from '@/modules/sampling/integrity.js';

afterEach(removeTemporaryDirectories);

async function setup(recorded: (hash: string) => Record<string, string>) {
  const directory = temporaryDirectory();
  const file = join(directory, 'sample.csv');
  writeFileSync(file, 'id\n1\n');
  const manifest = join(directory, 'manifest.json');
  writeFileSync(
    manifest,
    JSON.stringify({ sha256: recorded(await sha256File(file)) }),
  );
  return { file, manifest };
}

describe('assertSampleIntact', () => {
  it('should accept files whose hashes match the manifest', async () => {
    const { file, manifest } = await setup((hash) => ({ 'sample.csv': hash }));
    await expect(assertSampleIntact(manifest, [file])).resolves.toBeUndefined();
  });

  it('should reject a file changed after the sample was drawn', async () => {
    const { file, manifest } = await setup(() => ({ 'sample.csv': 'bad' }));
    await expect(assertSampleIntact(manifest, [file])).rejects.toThrow(
      /sample\.csv changed after the sample was drawn.*bad/,
    );
  });

  it('should reject a file the manifest does not record', async () => {
    const { file, manifest } = await setup(() => ({}));
    await expect(assertSampleIntact(manifest, [file])).rejects.toThrow(
      'does not record the SHA-256 of sample.csv',
    );
  });
});
