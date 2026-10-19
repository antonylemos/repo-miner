import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { writeCsv } from '@/common/csv.js';
import { readProvenance } from '@/modules/acquisition/provenance.js';

afterEach(removeTemporaryDirectories);

async function setup(options: { hits?: boolean; run?: string | null } = {}) {
  const root = temporaryDirectory();
  const round = join(root, 'round');
  const sample = join(root, 'sample');
  mkdirSync(round);
  mkdirSync(sample);
  writeFileSync(
    join(sample, 'manifest.json'),
    JSON.stringify({
      source: options.run === null ? {} : { run: options.run ?? round },
    }),
  );
  await writeCsv(
    join(round, 'candidates.csv'),
    ['id', 'full_name', 'metadata_json'],
    [
      [1, 'org/a', JSON.stringify({ language: 'TypeScript', size: 1234 })],
      [2, 'org/b', JSON.stringify({ description: 'x', fork: false })],
      [3, 'org/c', JSON.stringify({ language: 'Go', size: 9 })],
    ],
  );
  if (options.hits !== false)
    await writeCsv(
      join(round, 'discovery-hits.csv'),
      ['query_id', 'fetched_at', 'candidate_id'],
      [
        ['q2', '2026-10-08T18:02:00.000Z', 1],
        ['q1', '2026-10-08T15:44:00.000Z', 1],
        ['q1', '2026-10-09T10:00:00.000Z', 2],
        ['q1', '2026-10-01T10:00:00.000Z', 3],
      ],
    );
  return { sample };
}

describe('readProvenance', () => {
  it('should take the earliest fetch of a repository found by two queries', async () => {
    const { sample } = await setup();
    const result = await readProvenance(sample, ['1']);
    expect(result.get('1')?.discoveredAt).toBe('2026-10-08T15:44:00.000Z');
  });

  it('should read the language and size recorded by the search', async () => {
    const { sample } = await setup();
    const result = await readProvenance(sample, ['1']);
    expect(result.get('1')).toMatchObject({
      language: 'TypeScript',
      sizeKb: '1234',
    });
  });

  it('should leave the search metadata empty for a candidate that only has description and fork', async () => {
    const { sample } = await setup();
    const result = await readProvenance(sample, ['2']);
    expect(result.get('2')).toEqual({
      discoveredAt: '2026-10-09T10:00:00.000Z',
      language: '',
      sizeKb: '',
    });
  });

  it('should return only the requested repositories', async () => {
    const { sample } = await setup();
    const result = await readProvenance(sample, ['1', '2']);
    expect([...result.keys()]).toEqual(['1', '2']);
  });

  it('should reject a sample manifest without the discovery run', async () => {
    const { sample } = await setup({ run: null });
    await expect(readProvenance(sample, ['1'])).rejects.toThrow(
      'does not record the discovery run',
    );
  });

  it('should reject a round without discovery-hits.csv', async () => {
    const { sample } = await setup({ hits: false });
    await expect(readProvenance(sample, ['1'])).rejects.toThrow(
      'does not contain discovery-hits.csv',
    );
  });
});
