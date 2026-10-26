import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { sha256File } from '@/common/hash.js';
import { isRecord } from '@/common/records.js';

export type Annotation = {
  file: string;
  /** SHA-256 of the annotation file as read, so a later edit leaves a trace. */
  sha256: string;
  id: string;
  fullName: string;
  commit: string;
  classification: string;
  status: string;
  /** The whole front matter, for the configured required and exported fields. */
  data: Record<string, unknown>;
};

export type AnnotationReading = {
  annotations: Annotation[];
  /** One line per problem, each naming the file involved. */
  problems: string[];
};

const COMMIT = /^[0-9a-f]{40}$/;

/** Follows a dotted path (`annotation.method`) through nested maps. */
export function valueAt(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const key of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** The text between the opening `---` on the first line and the next `---` line. */
export function frontMatter(text: string): string | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return null;
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trimEnd() === '---',
  );
  return end === -1 ? null : lines.slice(1, end).join('\n');
}

function requiredText(
  data: Record<string, unknown>,
  path: string,
  where: string,
  problems: string[],
): string | null {
  const value = valueAt(data, path);
  if (typeof value === 'string' && value !== '') return value;
  problems.push(`${where}: ${path} must be a non-empty string`);
  return null;
}

function parseAnnotation(
  file: string,
  text: string,
  sha256: string,
  statusField: string,
  problems: string[],
): Annotation | null {
  const block = frontMatter(text);
  if (block === null) {
    problems.push(`${file}: no YAML front matter delimited by ---`);
    return null;
  }
  const document = parseDocument(block);
  if (document.errors.length > 0) {
    problems.push(
      `${file}: invalid YAML front matter (${document.errors[0]?.message.split('\n')[0]})`,
    );
    return null;
  }
  const data: unknown = document.toJS();
  if (!isRecord(data)) {
    problems.push(`${file}: the front matter must be a map`);
    return null;
  }
  const before = problems.length;
  if (data.schema !== 1)
    problems.push(`${file}: schema must be 1, found ${String(data.schema)}`);
  const id = data.id;
  if (!Number.isSafeInteger(id) && (typeof id !== 'string' || id === ''))
    problems.push(`${file}: id must be the repository id`);
  const fullName = requiredText(data, 'full_name', file, problems);
  const commit = requiredText(data, 'commit', file, problems);
  if (commit !== null && !COMMIT.test(commit))
    problems.push(`${file}: commit must be a full 40-character SHA`);
  const classification = requiredText(data, 'classification', file, problems);
  const status = requiredText(data, statusField, file, problems);
  if (problems.length > before) return null;
  return {
    file,
    sha256,
    id: String(id),
    fullName: fullName as string,
    commit: commit as string,
    classification: classification as string,
    status: status as string,
    data,
  };
}

/**
 * Reads every file matching `pattern`, extracting the structural fields every
 * annotation needs. Problems are collected rather than thrown so one run can
 * report them all.
 */
export async function readAnnotations(
  pattern: string,
  statusField: string,
): Promise<AnnotationReading> {
  const files: string[] = [];
  for await (const file of glob(pattern)) files.push(file);
  files.sort();
  const problems: string[] = [];
  if (files.length === 0)
    problems.push(`${pattern}: no annotation file matches the pattern`);
  const annotations: Annotation[] = [];
  for (const file of files) {
    const annotation = parseAnnotation(
      file,
      readFileSync(file, 'utf8'),
      await sha256File(file),
      statusField,
      problems,
    );
    if (annotation !== null) annotations.push(annotation);
  }
  return { annotations, problems };
}
