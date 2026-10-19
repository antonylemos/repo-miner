import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readCsv } from '@/common/csv.js';
import { isRecord } from '@/common/records.js';

/** What discovery recorded about a repository; empty when it recorded nothing. */
export type Provenance = {
  discoveredAt: string;
  language: string;
  sizeKb: string;
};

const EMPTY: Provenance = { discoveredAt: '', language: '', sizeKb: '' };

/** The round the sample was drawn from, as `manifest.json` records it. */
function roundDirectory(sampleDirectory: string): string {
  const manifest: unknown = JSON.parse(
    readFileSync(join(sampleDirectory, 'manifest.json'), 'utf8'),
  );
  const run =
    isRecord(manifest) && isRecord(manifest.source)
      ? manifest.source.run
      : undefined;
  if (typeof run !== 'string' || run === '')
    throw new Error(
      `${sampleDirectory}/manifest.json does not record the discovery run of the sample.`,
    );
  return resolve(run);
}

function columnsOf(header: string[], names: string[], file: string): number[] {
  return names.map((name) => {
    const index = header.indexOf(name);
    if (index === -1) throw new Error(`${file} lacks the column ${name}.`);
    return index;
  });
}

/** The earliest `fetched_at` of each candidate over all of its hits. */
async function firstHits(
  path: string,
  ids: Set<string>,
): Promise<Map<string, string>> {
  const first = new Map<string, string>();
  let columns: number[] | null = null;
  for await (const row of readCsv(path)) {
    if (columns === null) {
      columns = columnsOf(row, ['candidate_id', 'fetched_at'], path);
      continue;
    }
    const id = row[columns[0] as number] as string;
    const fetchedAt = row[columns[1] as number] as string;
    const earlier = first.get(id);
    if (
      ids.has(id) &&
      fetchedAt !== '' &&
      (earlier === undefined || fetchedAt < earlier)
    )
      first.set(id, fetchedAt);
  }
  return first;
}

/** `language` and `size` exist only for candidates found by a repository search. */
async function searchMetadata(
  path: string,
  ids: Set<string>,
): Promise<Map<string, { language: string; sizeKb: string }>> {
  const found = new Map<string, { language: string; sizeKb: string }>();
  let columns: number[] | null = null;
  for await (const row of readCsv(path)) {
    if (columns === null) {
      columns = columnsOf(row, ['id', 'metadata_json'], path);
      continue;
    }
    const id = row[columns[0] as number] as string;
    if (!ids.has(id)) continue;
    const text = row[columns[1] as number] as string;
    const metadata: unknown = JSON.parse(text === '' ? '{}' : text);
    if (!isRecord(metadata)) continue;
    found.set(id, {
      language: typeof metadata.language === 'string' ? metadata.language : '',
      sizeKb: typeof metadata.size === 'number' ? String(metadata.size) : '',
    });
  }
  return found;
}

/**
 * Reads, without changing anything, the discovery date and search metadata of
 * the sample's repositories from the round the sample was drawn from.
 */
export async function readProvenance(
  sampleDirectory: string,
  ids: Iterable<string>,
): Promise<Map<string, Provenance>> {
  const wanted = new Set(ids);
  const round = roundDirectory(sampleDirectory);
  const hitsPath = join(round, 'discovery-hits.csv');
  const candidatesPath = join(round, 'candidates.csv');
  for (const path of [hitsPath, candidatesPath])
    if (!existsSync(path))
      throw new Error(
        `The discovery round ${round} does not contain ${path.split('/').at(-1)}.`,
      );
  const hits = await firstHits(hitsPath, wanted);
  const metadata = await searchMetadata(candidatesPath, wanted);
  return new Map(
    [...wanted].map((id) => [
      id,
      {
        ...EMPTY,
        discoveredAt: hits.get(id) ?? '',
        ...metadata.get(id),
      },
    ]),
  );
}
