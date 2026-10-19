import { describe, expect, it } from 'vitest';
import {
  binaryReason,
  type ExclusionRules,
  exclusionReason,
  isBinaryContent,
  isLockfile,
} from '@/modules/acquisition/exclusion.js';

const all: ExclusionRules = {
  presets: ['node', 'python', 'build-output', 'binaries'],
  paths: [],
  maxFileBytes: null,
};

describe('exclusionReason', () => {
  it.each([
    ['node_modules/react/index.js', 'preset:node'],
    ['packages/app/node_modules/react/index.js', 'preset:node'],
    ['.yarn/cache/react.zip', 'preset:node'],
    ['api/.venv/lib/site.py', 'preset:python'],
    ['api/__pycache__/main.cpython-312.pyc', 'preset:python'],
    ['api/main.pyc', 'preset:python'],
    ['build/index.js', 'preset:build-output'],
    ['apps/web/dist/main.js', 'preset:build-output'],
    ['assets/logo.PNG', 'preset:binaries'],
  ])('should remove %s with the reason %s', (path, reason) => {
    expect(exclusionReason(path, 10, all)).toBe(reason);
  });

  it.each([
    'src/index.ts',
    'src/build.ts',
    'docs/dist.md',
    '.yarn/releases/yarn.cjs',
    'src/node_modules.ts',
    'logo.svg',
  ])('should keep %s', (path) => {
    expect(exclusionReason(path, 10, all)).toBeNull();
  });

  it('should keep a lockfile even inside a preset directory', () => {
    expect(exclusionReason('package-lock.json', 10, all)).toBeNull();
    expect(exclusionReason('build/yarn.lock', 10, all)).toBeNull();
    expect(exclusionReason('bun.lockb', 10, all)).toBeNull();
  });

  it('should ignore presets that are not active', () => {
    const rules = { ...all, presets: ['python' as const] };
    expect(exclusionReason('node_modules/a.js', 10, rules)).toBeNull();
  });

  it('should remove a path matching an extra pattern and report the pattern', () => {
    const rules = { ...all, paths: ['**/*.min.js'] };
    expect(exclusionReason('src/vendor/app.min.js', 10, rules)).toBe(
      'path:**/*.min.js',
    );
    expect(exclusionReason('src/app.js', 10, rules)).toBeNull();
  });

  it('should remove a file larger than the maximum size', () => {
    const rules = { ...all, maxFileBytes: 100 };
    expect(exclusionReason('data.json', 101, rules)).toBe('max-file-bytes');
    expect(exclusionReason('data.json', 100, rules)).toBeNull();
  });
});

describe('binaryReason', () => {
  it('should flag content with a NUL byte when the binaries preset is active', () => {
    expect(binaryReason('a.dat', Buffer.from([65, 0, 66]), all)).toBe(
      'preset:binaries',
    );
  });

  it('should keep text, lockfiles and everything when the preset is off', () => {
    expect(binaryReason('a.txt', Buffer.from('abc'), all)).toBeNull();
    expect(binaryReason('bun.lockb', Buffer.from([0]), all)).toBeNull();
    expect(
      binaryReason('a.dat', Buffer.from([0]), { ...all, presets: ['node'] }),
    ).toBeNull();
  });

  it('should look only at the first 8 KB', () => {
    const late = Buffer.alloc(9000, 65);
    late[8500] = 0;
    expect(isBinaryContent(late)).toBe(false);
  });
});

describe('isLockfile', () => {
  it('should recognize lockfiles by file name', () => {
    expect(isLockfile('apps/web/pnpm-lock.yaml')).toBe(true);
    expect(isLockfile('apps/web/package.json')).toBe(false);
  });
});
