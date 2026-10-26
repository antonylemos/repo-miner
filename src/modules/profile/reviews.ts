import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { sha256File } from '@/common/hash.js';
import { compareCodePoints } from '@/common/order.js';
import { isRecord } from '@/common/records.js';
import { frontMatter, valueAt } from '@/modules/acquisition/annotations.js';
import type { Extractor, ReviewVariable } from './config.js';

export type ReviewRepository = { fullName: string; commitSha: string };

export type ReviewReading = {
  /** Variable values by `full_name`. */
  values: Map<string, Record<string, string>>;
  /** SHA-256 of every review file that was read, by path. */
  files: Record<string, string>;
};

type ReviewFile = {
  path: string;
  fullName: string;
  commit: string;
  status: string;
  body: string;
};

function reviewsError(problems: string[]): Error {
  return new Error(
    `The reviews have ${problems.length} problem${problems.length === 1 ? '' : 's'}; nothing was written:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  );
}

/** The text after the closing `---` line of the front matter. */
function bodyOf(text: string): string {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trimEnd() === '---',
  );
  return lines.slice(end + 1).join('\n');
}

function parseReview(path: string, text: string): ReviewFile | string {
  const block = frontMatter(text);
  if (block === null) return `${path}: no YAML front matter delimited by ---`;
  const document = parseDocument(block);
  if (document.errors.length > 0)
    return `${path}: invalid YAML front matter (${document.errors[0]?.message.split('\n')[0]})`;
  const data: unknown = document.toJS();
  const fullName = isRecord(data) ? data.full_name : undefined;
  const commit = isRecord(data) ? data.commit : undefined;
  const status = valueAt(data, 'annotation.status');
  if (
    typeof fullName !== 'string' ||
    typeof commit !== 'string' ||
    typeof status !== 'string'
  )
    return `${path}: the front matter needs full_name, commit and annotation.status`;
  return { path, fullName, commit, status, body: bodyOf(text) };
}

/** Cells of a Markdown table row, split at the pipes that are not escaped. */
function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replaceAll('\\|', '|').trim());
}

/** The distinct values of a column of the first table in a `##` section, ordered. */
function columnValues(
  body: string,
  section: string,
  header: string,
): string | string[] {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${section}`);
  if (start === -1) return `has no section ## ${section}`;
  const next = lines.findIndex(
    (line, index) => index > start && /^#{1,2}\s/.test(line),
  );
  const inSection = lines.slice(start + 1, next === -1 ? undefined : next);
  const first = inSection.findIndex((line) => line.trim().startsWith('|'));
  // A section that only says there is nothing to list has no table: no values.
  if (first === -1) return [];
  const table: string[] = [];
  for (const line of inSection.slice(first)) {
    if (!line.trim().startsWith('|')) break;
    table.push(line);
  }
  const column = cells(table[0] as string).indexOf(header);
  if (column === -1)
    return `has no column ${header} in the table of ## ${section}`;
  const values = table
    .slice(2)
    .map((line) => cells(line)[column] ?? '')
    .filter((value) => value !== '');
  return [...new Set(values)].sort(compareCodePoints);
}

/** The value of a variable in the body of a review, or why it cannot be read. */
function extract(
  extractor: Extractor,
  body: string,
): string | { error: string } {
  if (extractor.kind === 'column') {
    const found = columnValues(body, extractor.section, extractor.header);
    return typeof found === 'string' ? { error: found } : found.join(';');
  }
  const match = extractor.pattern.exec(body);
  if (match === null) return { error: 'did not match the expression' };
  const captured = (match[1] ?? '').trim();
  if (extractor.kind === 'number')
    return /^\d+$/.test(captured)
      ? captured
      : { error: `captured "${captured}", which is not an integer` };
  if (extractor.empty.includes(captured)) return '0';
  return String(
    captured.split(extractor.separator).filter((item) => item.trim() !== '')
      .length,
  );
}

async function readReviewFiles(
  pattern: string,
  problems: string[],
): Promise<ReviewFile[]> {
  const paths: string[] = [];
  for await (const path of glob(pattern)) paths.push(path);
  paths.sort(compareCodePoints);
  const files: ReviewFile[] = [];
  for (const path of paths) {
    const review = parseReview(path, readFileSync(path, 'utf8'));
    if (typeof review === 'string') problems.push(review);
    else files.push(review);
  }
  return files;
}

/**
 * Reads, for each repository, the review file each variable names (found by
 * the `full_name` of its front matter), checks its commit and status, and runs
 * the extractor on its text. All problems are collected before failing.
 */
export async function readReviews(
  variables: ReviewVariable[],
  repositories: ReviewRepository[],
): Promise<ReviewReading> {
  const problems: string[] = [];
  const values = new Map<string, Record<string, string>>(
    repositories.map((repository) => [repository.fullName, {}]),
  );
  const used = new Set<string>();
  const parsed = new Map<string, ReviewFile[]>();

  for (const variable of variables) {
    let files = parsed.get(variable.files);
    if (files === undefined) {
      files = await readReviewFiles(variable.files, problems);
      parsed.set(variable.files, files);
    }
    for (const repository of repositories) {
      const found = files.filter(
        (file) => file.fullName === repository.fullName,
      );
      const where = `${repository.fullName} (${variable.name})`;
      if (found.length === 0) {
        problems.push(
          `${where}: no review file matching ${variable.files} has this full_name.`,
        );
        continue;
      }
      if (found.length > 1) {
        problems.push(
          `${where}: ${found.length} review files have this full_name: ${found.map((file) => file.path).join(', ')}.`,
        );
        continue;
      }
      const review = found[0] as ReviewFile;
      if (review.commit !== repository.commitSha) {
        problems.push(
          `${where}: ${review.path} has commit ${review.commit}, but the snapshot is ${repository.commitSha}.`,
        );
        continue;
      }
      if (!variable.statuses.includes(review.status)) {
        problems.push(
          `${where}: ${review.path} has the status ${review.status}, and only ${variable.statuses.join(', ')} is accepted.`,
        );
        continue;
      }
      used.add(review.path);
      const value = extract(variable.extractor, review.body);
      if (typeof value !== 'string') {
        problems.push(`${where}: ${review.path} ${value.error}.`);
        continue;
      }
      (values.get(repository.fullName) as Record<string, string>)[
        variable.name
      ] = value;
    }
  }
  if (problems.length > 0) throw reviewsError(problems);

  const files: Record<string, string> = {};
  for (const path of [...used].sort(compareCodePoints))
    files[path] = await sha256File(path);
  return { values, files };
}
