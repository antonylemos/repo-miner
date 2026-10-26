import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { replaceFiles, replaceOutput } from '@/common/output.js';

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

describe('replaceFiles', () => {
  const write = (directory: string, files: Record<string, string>) => {
    mkdirSync(directory, { recursive: true });
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(directory, name), content);
  };

  it('should replace the named files and leave the rest of the output alone', () => {
    const root = temporaryDirectory();
    write(join(root, 'out'), {
      'a.txt': 'old',
      'b.txt': 'old',
      'keep.txt': 'k',
    });
    write(join(root, 'out', 'api'), { 'page.json': 'cached' });
    write(join(root, 'staging'), { 'a.txt': 'new', 'b.txt': 'new' });
    replaceFiles(join(root, 'staging'), join(root, 'out'), ['a.txt', 'b.txt']);
    expect(readFileSync(join(root, 'out', 'a.txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(root, 'out', 'b.txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(root, 'out', 'keep.txt'), 'utf8')).toBe('k');
    expect(readFileSync(join(root, 'out', 'api', 'page.json'), 'utf8')).toBe(
      'cached',
    );
    expect(existsSync(join(root, 'out', '.previous'))).toBe(false);
  });

  it('should put the files in an output that has none of them', () => {
    const root = temporaryDirectory();
    write(join(root, 'out'), {});
    write(join(root, 'staging'), { 'a.txt': 'new' });
    replaceFiles(join(root, 'staging'), join(root, 'out'), ['a.txt']);
    expect(readFileSync(join(root, 'out', 'a.txt'), 'utf8')).toBe('new');
  });

  it('should bring the previous files back when a new one is missing', () => {
    const root = temporaryDirectory();
    write(join(root, 'out'), { 'a.txt': 'old', 'b.txt': 'old' });
    write(join(root, 'staging'), { 'a.txt': 'new' });
    expect(() =>
      replaceFiles(join(root, 'staging'), join(root, 'out'), [
        'a.txt',
        'b.txt',
      ]),
    ).toThrow();
    expect(readFileSync(join(root, 'out', 'a.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(root, 'out', 'b.txt'), 'utf8')).toBe('old');
    expect(existsSync(join(root, 'out', '.previous'))).toBe(false);
  });
});
