import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@/common/canonical-json.js';
import { writeCsv } from '@/common/csv.js';
import { sha256File } from '@/common/hash.js';
import type { SamplingConfig } from './config.js';
import { readPopulation } from './population.js';
import { type RankedCandidate, rankCandidates } from './ranking.js';

/** Files that mark a directory as an existing sample, never to be overwritten. */
export const SAMPLE_FILES = [
  'sample.csv',
  'ranking.csv',
  'manifest.json',
  'clones.csv',
  'catalog.csv',
];
export const RANKING_COLUMNS = [
  'rank',
  'id',
  'full_name',
  'url',
  'strategies',
  'eligibility_status',
  'hash',
];

export type SampleResult = {
  population: number;
  size: number;
  excluded: number;
  outputDir: string;
};

function rankingRow(candidate: RankedCandidate): unknown[] {
  return [
    candidate.rank,
    candidate.id,
    candidate.fullName,
    candidate.url,
    candidate.strategies,
    candidate.status ?? '',
    candidate.hash,
  ];
}

/** Draws a simple random sample from a round's exported candidates and writes it with its audit trail. */
export async function createSample(
  config: SamplingConfig,
  outputDir: string,
  now: () => Date = () => new Date(),
): Promise<SampleResult> {
  const used = SAMPLE_FILES.filter((file) => existsSync(join(outputDir, file)));
  if (used.length > 0)
    throw new Error(
      `${outputDir} already contains a sample (${used.join(', ')}); choose another output directory.`,
    );
  const population = await readPopulation(config.run, config.filter);
  const total = population.candidates.length;
  if (config.size > total)
    throw new Error(
      `The sample size X=${config.size} exceeds the filtered population N=${total}.`,
    );
  const ranking = rankCandidates(population.candidates, config.seed);
  const sample = ranking.slice(0, config.size);

  mkdirSync(outputDir, { recursive: true });
  const rankingPath = join(outputDir, 'ranking.csv');
  const samplePath = join(outputDir, 'sample.csv');
  await writeCsv(rankingPath, RANKING_COLUMNS, ranking.map(rankingRow));
  await writeCsv(samplePath, RANKING_COLUMNS, sample.map(rankingRow));
  const { exclusions, checks } = population;
  writeFileSync(
    join(outputDir, 'manifest.json'),
    `${JSON.stringify(
      {
        source: {
          run: config.run,
          runId: population.run.id,
          candidatesSha256: checks.candidatesSha256,
          checks: {
            hashMatchesManifest: true,
            totalCandidates: checks.totalCandidates,
            byEligibility: checks.byEligibility,
            unknownReasons: checks.unknownReasons,
          },
        },
        config,
        configSha256: createHash('sha256')
          .update(canonicalJson(config))
          .digest('hex'),
        seed: config.seed,
        totals: {
          source: checks.totalCandidates,
          population: total,
          size: config.size,
        },
        exclusions,
        createdAt: now().toISOString(),
        sha256: {
          'ranking.csv': await sha256File(rankingPath),
          'sample.csv': await sha256File(samplePath),
        },
      },
      null,
      2,
    )}\n`,
  );
  return {
    population: total,
    size: config.size,
    excluded: exclusions.total,
    outputDir,
  };
}
