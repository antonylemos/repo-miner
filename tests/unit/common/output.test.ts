import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { replaceOutput } from '@/common/output.js';

afterEach(removeTemporaryDirectories);

function directoryWith(path: string, content: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'file.txt'), content);
}

describe('replaceOutput', () => {
  it('should create the output when there was none', () => {
    const root = temporaryDirectory();
    directoryWith(join(root, 'out.partial'), 'new');
    replaceOutput(join(root, 'out.partial'), join(root, 'out'));
    expect(readFileSync(join(root, 'out', 'file.txt'), 'utf8')).toBe('new');
    expect(existsSync(join(root, 'out.partial'))).toBe(false);
  });

  it('should replace the previous output and remove it', () => {
    const root = temporaryDirectory();
    directoryWith(join(root, 'out'), 'old');
    directoryWith(join(root, 'out.partial'), 'new');
    replaceOutput(join(root, 'out.partial'), join(root, 'out'));
    expect(readFileSync(join(root, 'out', 'file.txt'), 'utf8')).toBe('new');
    expect(existsSync(join(root, 'out.previous'))).toBe(false);
  });

  it('should keep the previous output when the partial one is missing', () => {
    const root = temporaryDirectory();
    directoryWith(join(root, 'out'), 'old');
    expect(() =>
      replaceOutput(join(root, 'out.partial'), join(root, 'out')),
    ).toThrow();
    expect(readFileSync(join(root, 'out', 'file.txt'), 'utf8')).toBe('old');
    expect(existsSync(join(root, 'out.previous'))).toBe(false);
  });
});
