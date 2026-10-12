import { describe, expect, it } from 'vitest';
import type { Candidate } from '@/modules/sampling/population.js';
import { drawHash, rankCandidates } from '@/modules/sampling/ranking.js';

const candidate = (id: number): Candidate => ({
  id,
  fullName: `org/repo-${id}`,
  url: `https://github.com/org/repo-${id}`,
  strategies: 'terminology',
  status: 'pass',
  reasons: [],
});

const population = Array.from({ length: 60 }, (_, index) =>
  candidate(index + 1),
);

describe('drawHash', () => {
  it.each([
    [
      'seed-a',
      42,
      '00bdc7d11dac67936fc1dbca4a8b44b158896a599362910da0e4401c8f06e914',
    ],
    [
      'seed-a',
      7,
      '4de27349341a55f96c1452307b9e19261006c1d5177764b70c5a0062fae66009',
    ],
    [
      'seed-a',
      100,
      'f43e4e6eaac2eb6e86604daa209aec735eee86ede7b3d1ac2ea555126b5fe477',
    ],
  ])('should hash %s:%i as computed by shasum', (seed, id, expected) => {
    expect(drawHash(seed, id)).toBe(expected);
  });
});

describe('rankCandidates', () => {
  it('should order by hash and number the ranks from 1', () => {
    const ranked = rankCandidates(
      [candidate(42), candidate(7), candidate(100)],
      'seed-a',
    );
    expect(ranked.map((item) => [item.rank, item.id])).toEqual([
      [1, 42],
      [2, 7],
      [3, 100],
    ]);
    expect(ranked[0]?.hash).toBe(drawHash('seed-a', 42));
  });

  it('should not depend on the order of the input', () => {
    const reversed = [...population].reverse();
    const shuffled = [...population].sort(
      (a, b) => ((a.id * 7) % 13) - ((b.id * 7) % 13),
    );
    const expected = rankCandidates(population, 'seed-a');
    expect(rankCandidates(reversed, 'seed-a')).toEqual(expected);
    expect(rankCandidates(shuffled, 'seed-a')).toEqual(expected);
  });

  it('should keep a candidate at the same relative position in a larger population', () => {
    const small = rankCandidates(population.slice(0, 30), 'seed-a');
    const large = rankCandidates(population, 'seed-a');
    const inLarge = large
      .filter((item) => item.id <= 30)
      .map((item) => item.id);
    expect(small.map((item) => item.id)).toEqual(inLarge);
  });

  it('should change the order with another seed', () => {
    expect(
      rankCandidates(population, 'seed-a').map((item) => item.id),
    ).not.toEqual(rankCandidates(population, 'seed-b').map((item) => item.id));
  });

  it('should break equal hashes by numeric id', () => {
    const duplicate = [candidate(10), candidate(9), candidate(10)];
    const ranked = rankCandidates(duplicate, 'seed-a');
    expect(ranked.filter((item) => item.id === 10)).toHaveLength(2);
    expect(ranked.map((item) => item.rank)).toEqual([1, 2, 3]);
  });
});
