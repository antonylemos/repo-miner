import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '@tests/helpers.js';
import {
  createRound,
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256File } from '@/common/hash.js';
import type { SamplingFilter } from '@/modules/sampling/config.js';
import { createSample } from '@/modules/sampling/sample.js';

afterEach(removeTemporaryDirectories);

const candidates = Array.from({ length: 20 }, (_, index) => ({
  id: index + 1,
  status: index < 14 ? 'pass' : index < 18 ? 'fail' : 'unknown',
  rules:
    index >= 18
      ? ([['push_unavailable', 'unknown']] as [string, string][])
      : [],
}));

async function sampleOf(
  size: number,
  options: { seed?: string; filter?: SamplingFilter } = {},
) {
  const run = await createRound(candidates);
  const output = join(temporaryDirectory(), 'sample');
  const config = {
    run,
    size,
    seed: options.seed ?? 'seed-a',
    ...(options.filter ? { filter: options.filter } : {}),
  };
  const result = await createSample(
    config,
    output,
    () => new Date('2026-01-02T03:04:05.000Z'),
  );
  return { run, output, config, result };
}

const read = (directory: string, file: string) =>
  readFileSync(join(directory, file), 'utf8');

describe('createSample', () => {
  it('should write the ranking with the whole population and the sample with its first rows', async () => {
    const { output, result } = await sampleOf(5);
    const ranking = parseCsv(read(output, 'ranking.csv'));
    const sample = parseCsv(read(output, 'sample.csv'));
    expect(ranking[0]).toEqual([
      'rank',
      'id',
      'full_name',
      'url',
      'strategies',
      'eligibility_status',
      'hash',
    ]);
    expect(ranking).toHaveLength(21);
    expect(sample).toEqual(ranking.slice(0, 6));
    expect(result).toMatchObject({ population: 20, size: 5, excluded: 0 });
  });

  it('should copy the source fields so a row traces back to candidates.csv', async () => {
    const { output, run } = await sampleOf(3);
    const source = parseCsv(read(run, 'candidates.csv'));
    for (const [, id, fullName, url, strategies, status] of parseCsv(
      read(output, 'sample.csv'),
    ).slice(1)) {
      const matches = source.filter((row) => row[0] === id);
      expect(matches).toHaveLength(1);
      expect([
        matches[0]?.[1],
        matches[0]?.[2],
        matches[0]?.[6],
        matches[0]?.[3],
      ]).toEqual([fullName, url, strategies, status]);
    }
  });

  it('should produce byte-identical files when run twice', async () => {
    const first = await sampleOf(7);
    const output = join(temporaryDirectory(), 'again');
    await createSample(first.config, output);
    for (const file of ['ranking.csv', 'sample.csv'])
      expect(read(output, file)).toBe(read(first.output, file));
  });

  it('should nest a smaller sample inside a larger one with the same seed', async () => {
    const small = await sampleOf(4);
    const large = await sampleOf(9);
    const ids = (directory: string) =>
      parseCsv(read(directory, 'sample.csv'))
        .slice(1)
        .map((row) => row[1]);
    expect(ids(large.output).slice(0, 4)).toEqual(ids(small.output));
  });

  it('should record the audit trail in the manifest', async () => {
    const { output, run, config } = await sampleOf(5, {
      filter: {
        eligibilityStatus: ['pass', 'unknown'],
        excludeReasons: ['push_unavailable'],
      },
    });
    const manifest = JSON.parse(read(output, 'manifest.json'));
    expect(manifest.source).toMatchObject({
      run,
      runId: 'run-1',
      candidatesSha256: await sha256File(join(run, 'candidates.csv')),
      checks: { hashMatchesManifest: true, totalCandidates: 20 },
    });
    expect(manifest.config).toEqual(config);
    expect(manifest.configSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.seed).toBe('seed-a');
    expect(manifest.totals).toEqual({ source: 20, population: 14, size: 5 });
    expect(manifest.exclusions).toEqual({
      total: 6,
      byStatus: { fail: 4 },
      byReason: { push_unavailable: 2 },
    });
    expect(manifest.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(manifest.sha256).toEqual({
      'ranking.csv': await sha256File(join(output, 'ranking.csv')),
      'sample.csv': await sha256File(join(output, 'sample.csv')),
    });
  });

  it('should fail with N and X and write nothing when size exceeds the population', async () => {
    const run = await createRound(candidates);
    const output = join(temporaryDirectory(), 'sample');
    await expect(
      createSample({ run, size: 21, seed: 'a' }, output),
    ).rejects.toThrow(/X=21.*N=20/);
    expect(existsSync(output)).toBe(false);
  });

  it.each([
    'sample.csv',
    'ranking.csv',
    'manifest.json',
    'clones.csv',
    'catalog.csv',
  ])('should refuse a directory that already has %s', async (file) => {
    const run = await createRound(candidates);
    const output = temporaryDirectory();
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, file), 'keep');
    await expect(
      createSample({ run, size: 2, seed: 'a' }, output),
    ).rejects.toThrow(file);
    expect(read(output, file)).toBe('keep');
    expect(existsSync(join(output, 'ranking.csv'))).toBe(
      file === 'ranking.csv',
    );
  });
});
