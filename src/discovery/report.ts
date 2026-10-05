import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveryStore } from './storage.js';
import type { Strategy } from './types.js';

export async function exportRun(
  store: DiscoveryStore,
  outputDir: string,
): Promise<{ files: string[] }> {
  mkdirSync(outputDir, { recursive: true });
  const run = store.getRun();
  const queries = store.getCatalog().queries;
  const candidates = store.readCandidates();
  const hits = store.readHits();
  const coverage = store.readCoverage();
  const candidatesCsv = [
    ['id', 'full_name', 'url', 'metadata_json'],
    ...store
      .readCandidates()
      .map((candidate) => [
        candidate.id,
        candidate.fullName,
        candidate.url,
        JSON.stringify(candidate.metadata),
      ]),
  ]
    .map((row) => row.map(csvField).join(','))
    .join('\n');
  const candidatesPath = join(outputDir, 'candidates.csv');
  writeFileSync(candidatesPath, `${candidatesCsv}\n`, 'utf8');
  const hitsCsv = [
    [
      'query_id',
      'strategy',
      'candidate_id',
      'full_name',
      'repository_url',
      'path',
      'url',
      'metadata_json',
    ],
    ...store
      .readHits()
      .sort(
        (a, b) =>
          a.candidate.id - b.candidate.id ||
          compareText(a.queryId, b.queryId) ||
          compareText(a.path ?? '', b.path ?? ''),
      )
      .map((hit) => [
        hit.queryId,
        hit.strategy,
        hit.candidate.id,
        hit.candidate.fullName,
        hit.candidate.url,
        hit.path ?? '',
        hit.url,
        JSON.stringify(hit.candidate.metadata),
      ]),
  ]
    .map((row) => row.map(csvField).join(','))
    .join('\n');
  const hitsPath = join(outputDir, 'discovery-hits.csv');
  writeFileSync(hitsPath, `${hitsCsv}\n`, 'utf8');

  const byStrategy = Object.fromEntries(
    (['terminology', 'technology', 'broader'] as const).map((strategy) => {
      const strategyHits = hits.filter((hit) => hit.strategy === strategy);
      return [
        strategy,
        {
          hits: strategyHits.length,
          uniqueCandidates: new Set(strategyHits.map((hit) => hit.candidate.id))
            .size,
        },
      ];
    }),
  );
  const coverageData = {
    run,
    totals: { hits: hits.length, uniqueCandidates: candidates.length },
    byStrategy,
    coverage,
  };
  const coveragePath = join(outputDir, 'coverage.json');
  writeFileSync(
    coveragePath,
    `${JSON.stringify(coverageData, null, 2)}\n`,
    'utf8',
  );

  const queryById = new Map(queries.map((query) => [query.id, query]));
  const lines = [
    '# Diagnóstico da descoberta',
    '',
    `Rodada: ${run.id}`,
    `Estado: ${run.state}`,
    `Início: ${run.startedAt}`,
    `Fim: ${run.endedAt ?? 'em andamento'}`,
    '',
    `Hits coletados: ${hits.length}. Repositórios distintos: ${candidates.length}.`,
    '',
    '| Consulta | Estratégia | Hits | Repositórios únicos | Total informado pelo GitHub | Estado | Motivo |',
    '| --- | --- | ---: | ---: | ---: | --- | --- |',
    ...coverage.map((item) => {
      const query = queryById.get(item.queryId);
      return `| ${item.queryId} | ${query?.strategy ?? 'desconhecida'} | ${item.fetchedHits} | ${item.uniqueCandidates} | ${item.totalReported} | ${item.state} | ${item.reason ?? ''} |`;
    }),
    '',
    '## Contagens por estratégia',
    '',
    '| Estratégia | Hits | Repositórios únicos |',
    '| --- | ---: | ---: |',
    ...(['terminology', 'technology', 'broader'] as const).map((strategy) => {
      const stats = byStrategy[strategy];
      return `| ${strategy} | ${stats.hits} | ${stats.uniqueCandidates} |`;
    }),
    '',
    '## Interseções entre estratégias',
    '',
    ...strategyIntersections(hits).map(
      ({ left, right, count }) => `- ${left} ∩ ${right}: ${count} repositórios`,
    ),
    '',
    '## Consultas saturadas',
    '',
    ...(coverage.filter((item) => item.capped).length > 0
      ? coverage
          .filter((item) => item.capped)
          .map((item) => `- ${item.queryId}: revisar ou reformular a consulta.`)
      : ['Nenhuma consulta foi marcada como saturada.']),
    '',
    '## Implementações confirmadas',
    '',
    'Contagens de implementações confirmadas não estão disponíveis nesta etapa. A descoberta não determina abordagem, elegibilidade ou prevalência de micro-frontends.',
    '',
    '## Limitações',
    '',
    'A busca depende da indexação do GitHub, que pode retornar resultados incompletos, mudar durante a rodada e limitar a quantidade de resultados. Os totais observados descrevem apenas os hits destas consultas e não representam a população de repositórios.',
  ];
  const reportPath = join(outputDir, 'report.md');
  writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
  const exportedFiles = [candidatesPath, hitsPath, coveragePath, reportPath];
  const manifestPath = join(outputDir, 'manifest.json');
  const git = readGitRevision();
  const packageInfo = readJsonFile<{ version?: string }>(
    join(process.cwd(), 'package.json'),
  );
  const lockfilePath = join(process.cwd(), 'pnpm-lock.yaml');
  const lockfile = existsSync(lockfilePath)
    ? readFileSync(lockfilePath, 'utf8')
    : null;
  const lockfileVersion =
    lockfile?.match(/^lockfileVersion:\s*['"]?([^'"\s]+)/m)?.[1] ?? null;
  const manifest = {
    schemaVersion: 1,
    run: {
      id: run.id,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      catalogHash: run.catalogHash,
    },
    versions: {
      node: process.version,
      code: git.revision
        ? `git:${git.revision}`
        : packageInfo?.version
          ? `package:${packageInfo.version}`
          : null,
      lockfileVersion,
      lockfileSha256: lockfile ? sha256(lockfile) : null,
    },
    git: git.revision
      ? { available: true, revision: git.revision }
      : {
          available: false,
          revision: null,
          reason: 'Git metadata is unavailable',
        },
    sha256: Object.fromEntries(
      exportedFiles.map((file) => [
        file.split('/').at(-1),
        sha256(readFileSync(file)),
      ]),
    ),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { files: [...exportedFiles, manifestPath] };
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readGitRevision(): { revision: string | null } {
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { revision: revision || null };
  } catch {
    return { revision: null };
  }
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function strategyIntersections(
  hits: ReturnType<DiscoveryStore['readHits']>,
): Array<{ left: Strategy; right: Strategy; count: number }> {
  const strategies: Strategy[] = ['terminology', 'technology', 'broader'];
  const repositories = new Map<number, Set<Strategy>>();
  for (const hit of hits) {
    const strategiesForRepository =
      repositories.get(hit.candidate.id) ?? new Set();
    strategiesForRepository.add(hit.strategy);
    repositories.set(hit.candidate.id, strategiesForRepository);
  }
  const intersections: Array<{
    left: Strategy;
    right: Strategy;
    count: number;
  }> = [];
  for (let leftIndex = 0; leftIndex < strategies.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < strategies.length;
      rightIndex += 1
    ) {
      const left = strategies[leftIndex];
      const right = strategies[rightIndex];
      const count = [...repositories.values()].filter(
        (found) => found.has(left) && found.has(right),
      ).length;
      intersections.push({ left, right, count });
    }
  }
  return intersections;
}

function csvField(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
