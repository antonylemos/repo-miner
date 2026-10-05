import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateScope, type EffectivePush, effectivePush } from './scope.js';
import type { DiscoveryStore } from './storage.js';
import type {
  Coverage,
  EnrichmentStatus,
  Query,
  Run,
  Scope,
  StoredCandidate,
  StoredHit,
  Strategy,
} from './types.js';

const STRATEGIES: Strategy[] = ['terminology', 'technology', 'broader'];
const SCOPES: Scope[] = ['in_scope', 'out_of_scope_temporal', 'unknown'];
const ENRICHMENT_STATUSES: EnrichmentStatus[] = [
  'pending',
  'ok',
  'not_found',
  'failed',
];
const CANDIDATE_COLUMNS = [
  'id',
  'full_name',
  'url',
  'scope',
  'pushed_at',
  'pushed_at_source',
  'enrichment_status',
  'strategies',
  'metadata_json',
  'enrichment_json',
];
const HIT_COLUMNS = [
  'query_id',
  'subquery_id',
  'strategy',
  'endpoint',
  'q_effective',
  'fetched_at',
  'candidate_id',
  'full_name',
  'repository_url',
  'path',
  'url',
  'metadata_json',
];

type CandidateRow = {
  candidate: StoredCandidate;
  push: EffectivePush;
  scope: Scope;
  strategies: Strategy[];
};
type Intersections = {
  exclusive: Record<Strategy, number>;
  pairs: Array<{ left: Strategy; right: Strategy; count: number }>;
  all: number;
};
type QueryCoverage = {
  queryId: string;
  strategy: Strategy;
  subqueries: number;
  complete: number;
  partial: number;
  failed: number;
  pending: number;
  hits: number;
  uniqueCandidates: number;
};

export async function exportRun(
  store: DiscoveryStore,
  outputDir: string,
): Promise<{ files: string[] }> {
  mkdirSync(outputDir, { recursive: true });
  const run = store.getRun();
  const hits = store.readHits();
  const coverage = store.readCoverage();
  const enrichment = store.readEnrichmentCounts();
  const rows = candidateRows(store.readCandidates(), hits, run.pushedSince);
  const inScope = rows.filter((row) => row.scope === 'in_scope');
  const byScope = Object.fromEntries(
    SCOPES.map((scope) => [
      scope,
      rows.filter((row) => row.scope === scope).length,
    ]),
  ) as Record<Scope, number>;
  const byStrategy = {
    inScope: strategyCounts(inScope),
    all: strategyCounts(rows),
  };
  const overlap = intersections(inScope);
  const queries = queryCoverage(store.getCatalog().queries, coverage, hits);

  const candidatesPath = join(outputDir, 'candidates.csv');
  writeCsv(
    candidatesPath,
    CANDIDATE_COLUMNS,
    rows.map((row) => [
      row.candidate.id,
      row.candidate.fullName,
      row.candidate.url,
      row.scope,
      row.push.pushedAt ?? '',
      row.push.source ?? '',
      row.candidate.enrichment?.status ?? '',
      row.strategies.join(';'),
      JSON.stringify(row.candidate.metadata),
      row.candidate.enrichment?.data
        ? JSON.stringify(row.candidate.enrichment.data)
        : '',
    ]),
  );
  const hitsPath = join(outputDir, 'discovery-hits.csv');
  writeCsv(
    hitsPath,
    HIT_COLUMNS,
    [...hits]
      .sort(compareHits)
      .map((hit) => [
        hit.queryId,
        hit.subqueryId,
        hit.strategy,
        hit.endpoint,
        hit.qEffective,
        hit.fetchedAt,
        hit.candidate.id,
        hit.candidate.fullName,
        hit.candidate.url,
        hit.path ?? '',
        hit.url,
        JSON.stringify(hit.candidate.metadata),
      ]),
  );

  const coveragePath = join(outputDir, 'coverage.json');
  const coverageData = {
    run,
    totals: { hits: hits.length, uniqueCandidates: rows.length },
    byScope,
    byStrategy,
    intersections: overlap,
    enrichment,
    queries,
    subqueries: coverage,
  };
  writeFileSync(
    coveragePath,
    `${JSON.stringify(coverageData, null, 2)}\n`,
    'utf8',
  );

  const reportPath = join(outputDir, 'report.md');
  const lines = reportLines({
    run,
    hits,
    rows,
    byScope,
    byStrategy,
    overlap,
    enrichment,
    queries,
    coverage,
  });
  writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');

  const exportedFiles = [candidatesPath, hitsPath, coveragePath, reportPath];
  const manifestPath = join(outputDir, 'manifest.json');
  writeFileSync(
    manifestPath,
    `${JSON.stringify(buildManifest(run, exportedFiles), null, 2)}\n`,
    'utf8',
  );
  return { files: [...exportedFiles, manifestPath] };
}

function candidateRows(
  candidates: StoredCandidate[],
  hits: StoredHit[],
  pushedSince: string,
): CandidateRow[] {
  const strategiesById = new Map<number, Set<Strategy>>();
  for (const hit of hits) {
    const found = strategiesById.get(hit.candidate.id) ?? new Set<Strategy>();
    found.add(hit.strategy);
    strategiesById.set(hit.candidate.id, found);
  }
  return candidates.map((candidate) => {
    const push = effectivePush(candidate);
    const found = strategiesById.get(candidate.id) ?? new Set<Strategy>();
    return {
      candidate,
      push,
      scope: candidateScope(push, pushedSince),
      strategies: STRATEGIES.filter((strategy) => found.has(strategy)),
    };
  });
}

function strategyCounts(rows: CandidateRow[]): Record<Strategy, number> {
  return Object.fromEntries(
    STRATEGIES.map((strategy) => [
      strategy,
      rows.filter((row) => row.strategies.includes(strategy)).length,
    ]),
  ) as Record<Strategy, number>;
}

function intersections(rows: CandidateRow[]): Intersections {
  const has = (row: CandidateRow, strategy: Strategy) =>
    row.strategies.includes(strategy);
  const exclusive = Object.fromEntries(
    STRATEGIES.map((strategy) => [
      strategy,
      rows.filter((row) => row.strategies.length === 1 && has(row, strategy))
        .length,
    ]),
  ) as Record<Strategy, number>;
  const pairs: Intersections['pairs'] = [];
  for (let left = 0; left < STRATEGIES.length; left += 1) {
    for (let right = left + 1; right < STRATEGIES.length; right += 1) {
      pairs.push({
        left: STRATEGIES[left],
        right: STRATEGIES[right],
        count: rows.filter(
          (row) => has(row, STRATEGIES[left]) && has(row, STRATEGIES[right]),
        ).length,
      });
    }
  }
  const all = rows.filter((row) =>
    STRATEGIES.every((strategy) => has(row, strategy)),
  ).length;
  return { exclusive, pairs, all };
}

function queryCoverage(
  queries: Query[],
  coverage: Coverage[],
  hits: StoredHit[],
): QueryCoverage[] {
  return queries.map((query) => {
    const entries = coverage.filter((entry) => entry.queryId === query.id);
    const count = (state: Coverage['state']) =>
      entries.filter((entry) => entry.state === state).length;
    return {
      queryId: query.id,
      strategy: query.strategy,
      subqueries: entries.length,
      complete: count('complete'),
      partial: count('partial'),
      failed: count('failed'),
      pending: count('pending'),
      hits: entries.reduce((total, entry) => total + entry.fetchedHits, 0),
      uniqueCandidates: new Set(
        hits
          .filter((hit) => hit.queryId === query.id)
          .map((hit) => hit.candidate.id),
      ).size,
    };
  });
}

function reportLines(data: {
  run: Run;
  hits: StoredHit[];
  rows: CandidateRow[];
  byScope: Record<Scope, number>;
  byStrategy: {
    inScope: Record<Strategy, number>;
    all: Record<Strategy, number>;
  };
  overlap: Intersections;
  enrichment: Record<EnrichmentStatus, number>;
  queries: QueryCoverage[];
  coverage: Coverage[];
}): string[] {
  const { run, overlap } = data;
  const attention = data.coverage.filter(
    (entry) => entry.state === 'partial' || entry.state === 'failed',
  );
  return [
    '# Diagnóstico da descoberta',
    '',
    `Rodada: ${run.id}`,
    `Estado: ${run.state}`,
    `Início: ${run.startedAt}`,
    `Fim: ${run.endedAt ?? 'em andamento'}`,
    `Recorte temporal: pushed >= ${run.pushedSince}`,
    `Data de expansão das subconsultas: ${run.expansionDate}`,
    '',
    `Hits coletados: ${data.hits.length}. Repositórios distintos: ${data.rows.length}.`,
    '',
    '## Cobertura por consulta',
    '',
    '| Consulta | Estratégia | Subconsultas | Completas | Parciais | Falhas | Pendentes | Hits | Repositórios únicos |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...data.queries.map(
      (q) =>
        `| ${q.queryId} | ${q.strategy} | ${q.subqueries} | ${q.complete} | ${q.partial} | ${q.failed} | ${q.pending} | ${q.hits} | ${q.uniqueCandidates} |`,
    ),
    '',
    '## Subconsultas que exigem revisão',
    '',
    ...(attention.length > 0
      ? [
          'Subconsultas saturadas indicam partição insuficiente; revisar o catálogo antes da próxima rodada.',
          '',
          '| Subconsulta | Estado | Motivo |',
          '| --- | --- | --- |',
          ...attention.map(
            (entry) =>
              `| ${entry.subqueryId} | ${entry.state} | ${entry.reason ?? ''} |`,
          ),
        ]
      : ['Nenhuma subconsulta saturada ou com falha.']),
    '',
    '## Recorte temporal',
    '',
    '| Escopo | Repositórios |',
    '| --- | ---: |',
    ...SCOPES.map((scope) => `| ${scope} | ${data.byScope[scope]} |`),
    '',
    '## Contagens por estratégia',
    '',
    '| Estratégia | Repositórios in_scope | Repositórios (todos) |',
    '| --- | ---: | ---: |',
    ...STRATEGIES.map(
      (strategy) =>
        `| ${strategy} | ${data.byStrategy.inScope[strategy]} | ${data.byStrategy.all[strategy]} |`,
    ),
    '',
    '## Interseções entre estratégias (in_scope)',
    '',
    ...STRATEGIES.map(
      (strategy) => `- somente ${strategy}: ${overlap.exclusive[strategy]}`,
    ),
    ...overlap.pairs.map(
      ({ left, right, count }) => `- ${left} ∩ ${right}: ${count} repositórios`,
    ),
    `- ${STRATEGIES.join(' ∩ ')}: ${overlap.all} repositórios`,
    '',
    '## Enriquecimento',
    '',
    '| Status | Repositórios |',
    '| --- | ---: |',
    ...ENRICHMENT_STATUSES.map(
      (status) => `| ${status} | ${data.enrichment[status]} |`,
    ),
    '',
    '## Implementações confirmadas',
    '',
    'Contagens de implementações confirmadas não estão disponíveis nesta etapa. A descoberta não determina abordagem, elegibilidade ou prevalência de micro-frontends.',
    '',
    '## Limitações',
    '',
    '- A busca depende da indexação do GitHub, que pode retornar resultados incompletos, mudar durante a rodada e limitar cada consulta a 1.000 resultados. Os totais descrevem apenas estas consultas, não a população de repositórios.',
    '- As APIs de busca excluem forks por padrão; forks com implementação independente não são descobertos.',
    '- A busca de código considera apenas a branch padrão e arquivos de até 384 KB.',
    '- Web Components não possui artefato que distinga uso como MFE; esses casos dependem sobretudo da terminologia e da triagem.',
  ];
}

function buildManifest(run: Run, exportedFiles: string[]) {
  const root = findPackageRoot();
  const git = readGit(root);
  const packageInfo = root
    ? readJsonFile<{ version?: string }>(join(root, 'package.json'))
    : null;
  const lockfilePath = root ? join(root, 'pnpm-lock.yaml') : null;
  const lockfile =
    lockfilePath && existsSync(lockfilePath)
      ? readFileSync(lockfilePath, 'utf8')
      : null;
  const lockfileVersion =
    lockfile?.match(/^lockfileVersion:\s*['"]?([^'"\s]+)/m)?.[1] ?? null;
  return {
    schemaVersion: 2,
    run: {
      id: run.id,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      catalogHash: run.catalogHash,
      pushedSince: run.pushedSince,
      expansionDate: run.expansionDate,
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
      ? { available: true, revision: git.revision, dirty: git.dirty }
      : {
          available: false,
          revision: null,
          dirty: null,
          reason: 'Git metadata is unavailable',
        },
    sha256: Object.fromEntries(
      exportedFiles.map((file) => [
        file.split('/').at(-1),
        sha256(readFileSync(file)),
      ]),
    ),
  };
}

/** Resolves the package directory from this module, independent of the caller's working directory. */
function findPackageRoot(): string | null {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(directory, 'package.json'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function readGit(root: string | null): {
  revision: string | null;
  dirty: boolean | null;
} {
  if (!root) return { revision: null, dirty: null };
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  try {
    const revision = git(['rev-parse', 'HEAD']).trim();
    return {
      revision: revision || null,
      dirty: git(['status', '--porcelain']).trim().length > 0,
    };
  } catch {
    return { revision: null, dirty: null };
  }
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeCsv(path: string, columns: string[], rows: unknown[][]): void {
  const text = [columns, ...rows]
    .map((row) => row.map(csvField).join(','))
    .join('\n');
  writeFileSync(path, `${text}\n`, 'utf8');
}

function compareHits(left: StoredHit, right: StoredHit): number {
  return (
    left.candidate.id - right.candidate.id ||
    compareText(left.queryId, right.queryId) ||
    compareText(left.subqueryId, right.subqueryId) ||
    compareText(left.path ?? '', right.path ?? '')
  );
}

function csvField(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
