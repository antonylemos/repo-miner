import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCsv } from '@/common/csv.js';
import { sha256File } from '@/common/hash.js';

export type RoundCandidate = {
  id: number;
  status?: string;
  /** Rule results as `[reason, status]` pairs. */
  rules?: Array<[string, string]>;
  strategies?: string;
};

const directories: string[] = [];

export function removeTemporaryDirectories(): void {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
}

export function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'sampling-'));
  directories.push(directory);
  return directory;
}

/** Counts exactly as the discovery export does, so a fresh round passes the checks. */
export function countRound(candidates: RoundCandidate[]) {
  const byEligibility = { pass: 0, fail: 0, unknown: 0, not_applied: 0 };
  const unknownReasons: Record<string, number> = {};
  for (const candidate of candidates) {
    const status = (candidate.status ?? 'pass') as keyof typeof byEligibility;
    byEligibility[status] += 1;
    if (status !== 'unknown') continue;
    const reasons = new Set(
      (candidate.rules ?? [])
        .filter(([, ruleStatus]) => ruleStatus === 'unknown')
        .map(([reason]) => reason),
    );
    for (const reason of reasons)
      unknownReasons[reason] = (unknownReasons[reason] ?? 0) + 1;
  }
  return { byEligibility, unknownReasons };
}

/** Writes a round the way the export does: candidates.csv, coverage.json and a manifest with hashes. */
export async function createRound(
  candidates: RoundCandidate[],
  options: { eligibility?: boolean; runId?: string } = {},
): Promise<string> {
  const eligibility = options.eligibility ?? true;
  const directory = join(temporaryDirectory(), 'round');
  mkdirSync(directory, { recursive: true });
  const columns = [
    'id',
    'full_name',
    'url',
    ...(eligibility
      ? ['eligibility_status', 'eligibility_results_json', 'evidence_json']
      : []),
    'strategies',
    'metadata_json',
  ];
  await writeCsv(
    join(directory, 'candidates.csv'),
    columns,
    candidates.map((candidate) => [
      candidate.id,
      `org/repo-${candidate.id}`,
      `https://github.com/org/repo-${candidate.id}`,
      ...(eligibility
        ? [
            candidate.status ?? 'pass',
            JSON.stringify(
              (candidate.rules ?? []).map(([reason, status]) => ({
                reason,
                status,
                ruleId: 'rule',
              })),
            ),
            '{}',
          ]
        : []),
      candidate.strategies ?? 'terminology',
      '{}',
    ]),
  );
  const counts = eligibility ? countRound(candidates) : {};
  writeFileSync(
    join(directory, 'coverage.json'),
    JSON.stringify({
      totals: { hits: candidates.length, uniqueCandidates: candidates.length },
      ...counts,
    }),
  );
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      run: { id: options.runId ?? 'run-1' },
      sha256: {
        'candidates.csv': await sha256File(join(directory, 'candidates.csv')),
      },
    }),
  );
  return directory;
}

const identity = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/** A local repository standing in for a GitHub remote; returns its HEAD commit. */
export function createRemote(
  root: string,
  fullName: string,
  suffix = '',
): string {
  const path = join(root, `${fullName}${suffix}`);
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: path,
      env: { ...process.env, ...identity },
      encoding: 'utf8',
    });
  git('init', '--quiet', '-b', 'main');
  writeFileSync(join(path, 'README.md'), fullName);
  git('add', '.');
  git('commit', '--quiet', '-m', 'first');
  return git('rev-parse', 'HEAD').trim();
}
