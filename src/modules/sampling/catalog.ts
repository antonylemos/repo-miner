import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { csvField, readCsv } from '@/common/csv.js';

export const CATALOG_COLUMNS = ['id', 'url', 'classification'];

export type CatalogEntry = { id: number; url: string };

function endsWithLineBreak(path: string): boolean {
  const { size } = statSync(path);
  if (size === 0) return true;
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(1);
    readSync(descriptor, buffer, 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } finally {
    closeSync(descriptor);
  }
}

async function readIds(path: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let column = -1;
  for await (const row of readCsv(path)) {
    if (column === -1) {
      column = row.indexOf('id');
      if (column === -1) throw new Error(`${path} has no id column.`);
      continue;
    }
    const id = row[column];
    if (id !== undefined && id !== '') ids.add(id);
  }
  return ids;
}

/**
 * Appends a row with an empty `classification` for each entry whose id is not
 * in the catalog yet. Existing bytes, including filled classifications and
 * columns the researcher added, are never rewritten.
 */
export async function appendToCatalog(
  path: string,
  entries: CatalogEntry[],
): Promise<number> {
  const exists = existsSync(path) && statSync(path).size > 0;
  const known = exists ? await readIds(path) : new Set<string>();
  const fresh = entries.filter((entry) => !known.has(String(entry.id)));
  if (fresh.length === 0) return 0;
  const rows = fresh
    .map((entry) => `${csvField(entry.id)},${csvField(entry.url)},\n`)
    .join('');
  const header = exists ? '' : `${CATALOG_COLUMNS.join(',')}\n`;
  const separator = exists && !endsWithLineBreak(path) ? '\n' : '';
  appendFileSync(path, `${separator}${header}${rows}`, 'utf8');
  return fresh.length;
}
