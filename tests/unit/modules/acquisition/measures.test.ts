import { describe, expect, it } from 'vitest';
import {
  formatLanguages,
  languageOf,
  measure,
} from '@/modules/acquisition/measures.js';

describe('languageOf', () => {
  it.each([
    ['src/app.ts', 'TypeScript'],
    ['src/App.TSX', 'TypeScript'],
    ['src/app.vue', 'Vue'],
    ['styles/main.css', 'CSS'],
    ['Makefile', 'Other'],
    ['.gitignore', 'Other'],
    ['data.xyz', 'Other'],
  ])('should map %s to %s', (path, language) => {
    expect(languageOf(path)).toBe(language);
  });
});

describe('measure', () => {
  it('should count files and bytes and order languages by bytes', () => {
    const result = measure([
      { path: 'a.css', size: 10_240 },
      { path: 'a.ts', size: 20_480 },
      { path: 'b.ts', size: 10_240 },
      { path: 'LICENSE', size: 5 },
    ]);
    expect(result.files).toBe(4);
    expect(result.bytes).toBe(40_965);
    expect(formatLanguages(result.languages)).toBe(
      'TypeScript:30720;CSS:10240;Other:5',
    );
  });

  it('should break ties by language name', () => {
    const result = measure([
      { path: 'a.vue', size: 1 },
      { path: 'a.css', size: 1 },
    ]);
    expect(result.languages.map((item) => item.language)).toEqual([
      'CSS',
      'Vue',
    ]);
  });

  it('should measure an empty snapshot', () => {
    expect(measure([])).toEqual({ files: 0, bytes: 0, languages: [] });
    expect(formatLanguages([])).toBe('');
  });
});
