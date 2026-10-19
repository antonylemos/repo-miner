import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function csvField(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Streams rows to disk so the file size is not bounded by the maximum string length. */
export async function writeCsv(
  path: string,
  columns: string[],
  rows: Iterable<unknown[]>,
): Promise<void> {
  function* lines() {
    yield `${columns.map(csvField).join(',')}\n`;
    for (const row of rows) yield `${row.map(csvField).join(',')}\n`;
  }
  const iterator = lines();
  try {
    await pipeline(Readable.from(iterator), createWriteStream(path, 'utf8'));
  } finally {
    // Close nested generators and the SQLite cursor even if the destination fails.
    iterator.return();
  }
}

/**
 * Streams the records of an RFC 4180 file, handling quotes, doubled quotes and
 * commas or line breaks inside fields, with no limit on field size. A leading
 * byte order mark is ignored and both LF and CRLF end a record.
 */
export async function* readCsv(path: string): AsyncGenerator<string[]> {
  let row: string[] = [];
  let field = '';
  let quoted = false;
  // Inside quotes, a quote is closing or the first half of an escaped quote
  // until the next character says which, possibly in the next chunk.
  let quoteSeen = false;
  let pending = false;
  let first = true;
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    const text =
      first && chunk.charCodeAt(0) === 0xfeff ? chunk.slice(1) : chunk;
    first = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoteSeen) {
        quoteSeen = false;
        if (char === '"') {
          field += '"';
          continue;
        }
        quoted = false;
      }
      if (quoted) {
        if (char === '"') quoteSeen = true;
        else field += char;
      } else if (char === '"' && field === '') {
        quoted = true;
        pending = true;
      } else if (char === ',') {
        row.push(field);
        field = '';
        pending = true;
      } else if (char === '\n') {
        if (field.endsWith('\r')) field = field.slice(0, -1);
        row.push(field);
        yield row;
        row = [];
        field = '';
        pending = false;
      } else {
        field += char;
        pending = true;
      }
    }
  }
  if (quoteSeen) quoted = false;
  if (quoted) throw new Error(`${path}: unterminated quoted field`);
  if (pending || field !== '' || row.length > 0) {
    row.push(field);
    yield row;
  }
}

/** Reads a CSV file with a header into one record per row, requiring the given columns. */
export async function readCsvRecords(
  path: string,
  columns: string[] = [],
): Promise<Array<Record<string, string>>> {
  const rows: Array<Record<string, string>> = [];
  let header: string[] | null = null;
  for await (const row of readCsv(path)) {
    if (header === null) {
      header = row;
      const missing = columns.filter((name) => !header?.includes(name));
      if (missing.length > 0)
        throw new Error(`${path} lacks the columns ${missing.join(', ')}.`);
      continue;
    }
    if (row.length === 1 && row[0] === '') continue;
    rows.push(
      Object.fromEntries(header.map((name, index) => [name, row[index] ?? ''])),
    );
  }
  return rows;
}
