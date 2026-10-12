import { createHash } from 'node:crypto';
import type { Candidate } from './population.js';

export type RankedCandidate = Candidate & { rank: number; hash: string };

export function drawHash(seed: string, id: number): string {
  return createHash('sha256').update(`${seed}:${id}`).digest('hex');
}

/**
 * Orders candidates by `sha256(seed:id)` ascending, ties broken by numeric id.
 * Only each candidate's own data takes part, so the order of the input never
 * changes the result and a smaller sample is a prefix of a larger one.
 */
export function rankCandidates(
  candidates: Candidate[],
  seed: string,
): RankedCandidate[] {
  return candidates
    .map((candidate) => ({
      ...candidate,
      hash: drawHash(seed, candidate.id),
    }))
    .sort(
      (left, right) =>
        (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0) ||
        left.id - right.id,
    )
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
