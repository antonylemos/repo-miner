import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareCodePoints } from '@/common/order.js';
import type { ArtifactFile } from './artifacts.js';
import type { MiningPattern } from './config.js';

/** Longest excerpt of a matching line, so lockfiles and minified lines do not inflate the CSV. */
export const EXCERPT_LENGTH = 300;

export type Match = {
  pattern: string;
  path: string;
  /** From 1; null for a presence pattern. */
  line: number | null;
  /** Null for a presence pattern. */
  excerpt: string | null;
};

/** The lines of `text` that `regex` matches: one entry per line, however many times it matches. */
export function matchLines(
  text: string,
  regex: RegExp,
): Array<{ line: number; excerpt: string }> {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const found: Array<{ line: number; excerpt: string }> = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (regex.test(line))
      found.push({ line: index + 1, excerpt: line.slice(0, EXCERPT_LENGTH) });
  }
  return found;
}

/**
 * Applies each pattern to the files that have one of its artifact types, in
 * the order of the catalog, then path, then line. A pattern without `regex`
 * matches each of those files once, with no line.
 */
export function findMatches(
  filesDirectory: string,
  files: ArtifactFile[],
  patterns: MiningPattern[],
): Match[] {
  const matches: Array<Match & { order: number }> = [];
  for (const file of files) {
    const applicable = patterns
      .map((pattern, order) => ({ pattern, order }))
      .filter(({ pattern }) =>
        pattern.artifactTypes.some((type) => file.types.includes(type)),
      );
    if (applicable.length === 0) continue;
    const searching = applicable.filter(({ pattern }) => pattern.regex);
    // Invalid UTF-8 is replaced, so the search goes on and the path stays in the inventory.
    const text =
      searching.length > 0
        ? readFileSync(join(filesDirectory, file.path), 'utf8')
        : '';
    for (const { pattern, order } of applicable) {
      if (pattern.regex === null)
        matches.push({
          pattern: pattern.id,
          path: file.path,
          line: null,
          excerpt: null,
          order,
        });
      else
        for (const { line, excerpt } of matchLines(text, pattern.regex))
          matches.push({
            pattern: pattern.id,
            path: file.path,
            line,
            excerpt,
            order,
          });
    }
  }
  return matches
    .sort(
      (a, b) =>
        a.order - b.order ||
        compareCodePoints(a.path, b.path) ||
        (a.line ?? 0) - (b.line ?? 0),
    )
    .map(({ order: _order, ...match }) => match);
}
