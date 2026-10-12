import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256File } from '@/common/hash.js';

afterEach(removeTemporaryDirectories);

describe('sha256File', () => {
  it('should hash the file content', async () => {
    const path = join(temporaryDirectory(), 'file.txt');
    writeFileSync(path, 'abc');
    expect(await sha256File(path)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
