import { describe, expect, it } from 'vitest';
import { packageDirectory, packageOf } from '@/modules/inspection/packages.js';

describe('packageOf', () => {
  it('should keep a subdirectory with its own index.html in the package of the root', () => {
    expect(packageOf('src/main.ts', ['.'])).toBe('.');
    expect(packageOf('src/index.html', ['.'])).toBe('.');
  });

  it('should pick the deepest nested package', () => {
    expect(
      packageOf('packages/app-mf-1/src/App.tsx', ['.', 'packages/app-mf-1']),
    ).toBe('packages/app-mf-1');
  });

  it('should not take a directory whose name only starts like a segment', () => {
    expect(packageOf('app-2/webpack.config.js', ['.', 'app'])).toBe('.');
  });

  it('should be empty for a file outside every package', () => {
    expect(packageOf('tools/webpack.config.js', ['apps/a'])).toBe('');
  });

  it('should not depend on the order of the directories', () => {
    expect(packageOf('a/b/c.js', ['a/b', '.', 'a'])).toBe('a/b');
  });
});

describe('packageDirectory', () => {
  it.each([
    ['package.json', '.'],
    ['apps/shell/package.json', 'apps/shell'],
  ])('should give the directory of %s', (path, directory) => {
    expect(packageDirectory(path)).toBe(directory);
  });
});
