import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRound,
  type RoundCandidate,
  removeTemporaryDirectories,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256File } from '@/common/hash.js';
import { readPopulation } from '@/modules/sampling/population.js';

afterEach(removeTemporaryDirectories);

const mixed: RoundCandidate[] = [
  { id: 1, status: 'pass', rules: [['qualifying_commit', 'pass']] },
  { id: 2, status: 'fail', rules: [['no_recent_push', 'fail']] },
  {
    id: 3,
    status: 'unknown',
    rules: [
      ['push_unavailable', 'unknown'],
      ['activity_incomplete', 'unknown'],
    ],
  },
  { id: 4, status: 'unknown', rules: [['activity_incomplete', 'unknown']] },
  { id: 5, status: 'pass', rules: [['qualifying_commit', 'pass']] },
];

describe('reading a round', () => {
  it.each(['candidates.csv', 'coverage.json', 'manifest.json'])(
    'should fail when %s is missing',
    async (file) => {
      const round = await createRound(mixed);
      rmSync(join(round, file));
      await expect(readPopulation(round)).rejects.toThrow(file);
    },
  );

  it('should fail with both hashes when candidates.csv changed after the export', async () => {
    const round = await createRound(mixed);
    const path = join(round, 'candidates.csv');
    const expected = await sha256File(path);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
    const actual = await sha256File(path);
    const message = await readPopulation(round).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(message).toContain(expected);
    expect(message).toContain(actual);
  });

  it('should read the candidates by column name with the run id and hash', async () => {
    const round = await createRound(mixed, { runId: 'run-xyz' });
    const population = await readPopulation(round);
    expect(population.run.id).toBe('run-xyz');
    expect(population.checks.candidatesSha256).toBe(
      await sha256File(join(round, 'candidates.csv')),
    );
    expect(population.candidates.map((candidate) => candidate.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(population.candidates[0]).toMatchObject({
      fullName: 'org/repo-1',
      url: 'https://github.com/org/repo-1',
      strategies: 'terminology',
      status: 'pass',
    });
  });

  it('should keep every candidate when there is no filter', async () => {
    const population = await readPopulation(await createRound(mixed));
    expect(population.candidates).toHaveLength(5);
    expect(population.exclusions).toEqual({
      total: 0,
      byStatus: {},
      byReason: {},
    });
  });

  it('should read a round exported without eligibility', async () => {
    const round = await createRound([{ id: 1 }, { id: 2 }], {
      eligibility: false,
    });
    const population = await readPopulation(round);
    expect(population.candidates.map((candidate) => candidate.status)).toEqual([
      null,
      null,
    ]);
    expect(population.checks.byEligibility).toBeNull();
  });
});

describe('checking the counts against coverage.json', () => {
  type Coverage = {
    totals: { uniqueCandidates: number };
    byEligibility: Record<string, number>;
    unknownReasons: Record<string, number>;
  };
  async function withCoverage(change: (coverage: Coverage) => void) {
    const round = await createRound(mixed);
    const path = join(round, 'coverage.json');
    const coverage = JSON.parse(readFileSync(path, 'utf8')) as Coverage;
    change(coverage);
    writeFileSync(path, JSON.stringify(coverage));
    return round;
  }

  it('should report the expected and the read total on a mismatch', async () => {
    const round = await withCoverage((c) => {
      c.totals.uniqueCandidates = 6;
    });
    await expect(readPopulation(round)).rejects.toThrow(
      /expects 6, candidates\.csv has 5/,
    );
  });

  it('should report the expected and the read count of a status', async () => {
    const round = await withCoverage((c) => {
      c.byEligibility.pass = 3;
    });
    await expect(readPopulation(round)).rejects.toThrow(
      /status pass: coverage\.json expects 3, candidates\.csv has 2/,
    );
  });

  it('should count a candidate once for each distinct unknown reason', async () => {
    const population = await readPopulation(await createRound(mixed));
    expect(population.checks.unknownReasons).toEqual({
      push_unavailable: 1,
      activity_incomplete: 2,
    });
  });

  it('should fail when an unknown reason count differs', async () => {
    const round = await withCoverage((c) => {
      c.unknownReasons.push_unavailable = 4;
    });
    await expect(readPopulation(round)).rejects.toThrow(
      /Unknown reason push_unavailable: coverage\.json expects 4, candidates\.csv has 1/,
    );
  });

  it('should ignore pending_evaluation in coverage.json', async () => {
    const round = await withCoverage((c) => {
      c.unknownReasons.pending_evaluation = 7;
    });
    await expect(readPopulation(round)).resolves.toBeDefined();
  });
});

describe('filtering the population', () => {
  const filter = {
    eligibilityStatus: ['pass', 'unknown'] as ('pass' | 'unknown')[],
    excludeReasons: ['push_unavailable'],
  };

  it('should keep pass and unknown without push_unavailable', async () => {
    const population = await readPopulation(await createRound(mixed), filter);
    expect(population.candidates.map((candidate) => candidate.id)).toEqual([
      1, 4, 5,
    ]);
    expect(population.exclusions).toEqual({
      total: 2,
      byStatus: { fail: 1 },
      byReason: { push_unavailable: 1 },
    });
  });

  it('should exclude by status before reason', async () => {
    const round = await createRound([
      { id: 1, status: 'fail', rules: [['push_unavailable', 'unknown']] },
      { id: 2, status: 'pass', rules: [] },
    ]);
    const population = await readPopulation(round, filter);
    expect(population.exclusions).toEqual({
      total: 1,
      byStatus: { fail: 1 },
      byReason: {},
    });
  });

  it('should count a candidate with two excluded reasons once for each', async () => {
    const round = await createRound([
      {
        id: 1,
        status: 'unknown',
        rules: [
          ['push_unavailable', 'unknown'],
          ['activity_incomplete', 'unknown'],
        ],
      },
      { id: 2, status: 'pass', rules: [] },
    ]);
    const population = await readPopulation(round, {
      excludeReasons: ['push_unavailable', 'activity_incomplete'],
    });
    expect(population.candidates.map((candidate) => candidate.id)).toEqual([2]);
    expect(population.exclusions).toEqual({
      total: 1,
      byStatus: {},
      byReason: { push_unavailable: 1, activity_incomplete: 1 },
    });
  });

  it('should fail when there is a filter and no eligibility columns', async () => {
    const round = await createRound([{ id: 1 }], { eligibility: false });
    await expect(readPopulation(round, filter)).rejects.toThrow(
      /no eligibility columns/,
    );
  });
});
