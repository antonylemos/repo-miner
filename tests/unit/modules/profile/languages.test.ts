import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { formatShare, measureLanguages } from '@/modules/profile/languages.js';

afterEach(removeTemporaryDirectories);

/** A snapshot whose files have the given sizes. */
function snapshot(sizes: Record<string, number>): string {
  const directory = temporaryDirectory();
  for (const [path, size] of Object.entries(sizes)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), 'x'.repeat(size));
  }
  return directory;
}

const languages = {
  measured: ['TypeScript', 'CSS', 'Python'],
  frontend: ['TypeScript', 'CSS'],
  excludeFiles: ['**/package-lock.json'],
};

describe('measureLanguages', () => {
  it('should leave lockfiles and context languages out of the proportions', () => {
    const profile = measureLanguages(
      snapshot({
        'src/a.ts': 600,
        'src/b.css': 200,
        'package-lock.json': 5000,
        'tsconfig.json': 100,
      }),
      languages,
    );
    expect(profile.files).toBe(4);
    expect(profile.excludedFiles).toBe(1);
    expect(profile.rows).toEqual([
      { language: 'CSS', group: 'measured', files: 1, bytes: 200, share: 0.25 },
      { language: 'JSON', group: 'context', files: 1, bytes: 100, share: null },
      {
        language: 'JSON',
        group: 'excluded',
        files: 1,
        bytes: 5000,
        share: null,
      },
      {
        language: 'TypeScript',
        group: 'measured',
        files: 1,
        bytes: 600,
        share: 0.75,
      },
    ]);
  });

  it('should sum the frontend languages and name the dominant one', () => {
    const profile = measureLanguages(
      snapshot({ 'a.ts': 60, 'b.css': 10, 'c.py': 30 }),
      languages,
    );
    expect(profile.frontendShare).toBeCloseTo(0.7);
    expect(profile.dominantLanguage).toBe('TypeScript');
  });

  it('should break a tie by language name', () => {
    const profile = measureLanguages(
      snapshot({ 'a.ts': 10, 'b.css': 10 }),
      languages,
    );
    expect(profile.dominantLanguage).toBe('CSS');
  });

  it('should leave the proportions empty when no file is of a measured language', () => {
    const profile = measureLanguages(
      snapshot({ 'README.md': 10, 'x.unknown': 5 }),
      languages,
    );
    expect(profile.frontendShare).toBeNull();
    expect(profile.dominantLanguage).toBeNull();
    expect(profile.rows.map((row) => [row.language, row.share])).toEqual([
      ['Markdown', null],
      ['Other', null],
    ]);
    expect(profile.files).toBe(2);
  });

  it('should count an excluded file of a measured language apart', () => {
    const profile = measureLanguages(snapshot({ 'a.ts': 10, 'gen.ts': 90 }), {
      ...languages,
      excludeFiles: ['gen.ts'],
    });
    expect(profile.excludedFiles).toBe(1);
    expect(profile.rows.find((row) => row.group === 'measured')?.share).toBe(1);
    expect(profile.rows.find((row) => row.group === 'excluded')?.bytes).toBe(
      90,
    );
  });

  it('should count the empty snapshot as zero files', () => {
    const profile = measureLanguages(snapshot({}), languages);
    expect(profile).toMatchObject({ files: 0, rows: [], frontendShare: null });
  });
});

describe('formatShare', () => {
  it('should print six decimals and nothing for a missing proportion', () => {
    expect(formatShare(0.75)).toBe('0.750000');
    expect(formatShare(1 / 3)).toBe('0.333333');
    expect(formatShare(null)).toBe('');
  });
});
