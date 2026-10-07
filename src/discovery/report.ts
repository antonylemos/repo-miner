import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollectionSummary } from './collectors/types.js';
import {
  EVALUATOR_VERSIONS,
  evaluateProtocol,
} from './eligibility/evaluate.js';
import { hasEligibility } from './eligibility/protocol.js';
import type {
  CandidateFacts,
  ProtocolEvaluation,
} from './eligibility/types.js';
import {
  compareHits,
  environmentManifest,
  exportedMetadata,
  HIT_COLUMNS,
  type Intersections,
  intersections,
  type QueryCoverage,
  queryCoverage,
  sha256File,
  strategiesByCandidate,
  strategyCounts,
  strategyLabels,
  writeCsv,
} from './report/common.js';
import type { DiscoveryStore, Run } from './storage/store.js';
import type { Coverage, Strategy } from './types.js';

/** Reports the export step about to run: `done` of `total` steps finished so far. */
export type ExportProgress = (
  done: number,
  total: number,
  label: string,
) => void;
/** Eligibility and collection keys appear only when the run's protocol has rules. */
export type RunCoverage = {
  run: Run;
  totals: { hits: number; uniqueCandidates: number };
  byStrategy: {
    all: Record<Strategy, number>;
    pass?: Record<Strategy, number>;
  };
  intersections: { all: Intersections; pass?: Intersections };
  queries: QueryCoverage[];
  subqueries: Coverage[];
  byEligibility?: Record<ProtocolEvaluation['status'], number>;
  unknownReasons?: Record<string, number>;
  collection?: CollectionSummary;
};
const BASE_COLUMNS = ['id', 'full_name', 'url'];
const ELIGIBILITY_COLUMNS = [
  'eligibility_status',
  'eligibility_results_json',
  'evidence_json',
];
const TAIL_COLUMNS = ['strategies', 'metadata_json'];
type SummaryRow = {
  id: number;
  strategies: Strategy[];
  status: ProtocolEvaluation['status'] | null;
};
type ObservedCoverage = {
  repositoryId: number;
  inspectionUntil: string | null;
  coverage: CandidateFacts['coverage'];
};
/** Every artifact, including the file hashes, is derived while this read transaction remains open. */
export async function exportRun(
  store: DiscoveryStore,
  outputDir: string,
  onProgress: ExportProgress = () => {},
): Promise<{ files: string[] }> {
  return store.withReadSnapshot(async (snapshot) => {
    mkdirSync(outputDir, { recursive: true });
    onProgress(0, 6, 'lendo dados');
    const run = snapshot.getRun();
    const eligible = hasEligibility(run.protocol);
    const labels = strategyLabels(run.catalog.queries);
    const hits = snapshot.readHits();
    const subqueries = snapshot.readCoverage();
    const strategies = strategiesByCandidate(hits);
    const rows: SummaryRow[] = [];
    const observed: ObservedCoverage[] = [];
    const unknownReasons: Record<string, number> = {};
    const byEligibility: Record<ProtocolEvaluation['status'], number> = {
      pass: 0,
      fail: 0,
      unknown: 0,
      not_applied: 0,
    };
    function* candidates(): Generator<unknown[]> {
      for (const candidate of snapshot.iterateCandidates()) {
        const found = labels.filter((s) =>
          strategies.get(candidate.id)?.has(s),
        );
        const common = [candidate.id, candidate.fullName, candidate.url];
        const tail = [
          found.join(';'),
          JSON.stringify(exportedMetadata(candidate.metadata)),
        ];
        if (!eligible) {
          rows.push({ id: candidate.id, strategies: found, status: null });
          yield [...common, ...tail];
          continue;
        }
        const facts = snapshot.readCandidateFacts(candidate.id);
        const recorded =
          candidate.evaluation !== null &&
          candidate.evaluationRevision === facts.revision;
        const evaluation = recorded
          ? (candidate.evaluation as ProtocolEvaluation)
          : evaluateProtocol(run.protocol, facts);
        rows.push({
          id: candidate.id,
          strategies: found,
          status: evaluation.status,
        });
        byEligibility[evaluation.status]++;
        if (evaluation.status === 'unknown') {
          // Count candidates once for each reason even if several rules share it.
          const reasons = new Set(
            evaluation.rules
              .filter((r) => r.status === 'unknown')
              .map((r) => r.reason),
          );
          if (!recorded) reasons.add('pending_evaluation');
          for (const reason of reasons)
            unknownReasons[reason] = (unknownReasons[reason] ?? 0) + 1;
        }
        observed.push({
          repositoryId: candidate.id,
          inspectionUntil: facts.inspectionUntil,
          coverage: facts.coverage,
        });
        yield [
          ...common,
          evaluation.status,
          JSON.stringify(evaluation.rules),
          JSON.stringify({
            factsRevision: facts.revision,
            evaluationRevision: recorded
              ? candidate.evaluationRevision
              : facts.revision,
            recordedEvaluationRevision: candidate.evaluationRevision,
            evaluationSource: recorded ? 'recorded' : 'snapshot',
            evaluatorVersions: recorded
              ? run.evaluatorVersions
              : EVALUATOR_VERSIONS,
            inspectionUntil: facts.inspectionUntil,
            observations: facts.observations,
            commits: facts.commits,
            coverage: facts.coverage,
          }),
          ...tail,
        ];
      }
    }
    const candidatesPath = join(outputDir, 'candidates.csv');
    onProgress(1, 6, 'candidates.csv');
    await writeCsv(
      candidatesPath,
      [
        ...BASE_COLUMNS,
        ...(eligible ? ELIGIBILITY_COLUMNS : []),
        ...TAIL_COLUMNS,
      ],
      candidates(),
    );
    const hitsPath = join(outputDir, 'discovery-hits.csv');
    onProgress(2, 6, 'discovery-hits.csv');
    await writeCsv(
      hitsPath,
      HIT_COLUMNS,
      [...hits]
        .sort(compareHits)
        .map((h) => [
          h.queryId,
          h.subqueryId,
          h.strategy,
          h.endpoint,
          h.qEffective,
          h.fetchedAt,
          h.candidate.id,
          h.candidate.fullName,
          h.candidate.url,
          h.path ?? '',
          h.url,
        ]),
    );
    const passed = rows.filter((r) => r.status === 'pass');
    const collection = eligible ? snapshot.readCollectionSummary() : null;
    const coverage: RunCoverage = {
      run,
      totals: { hits: hits.length, uniqueCandidates: rows.length },
      byStrategy: {
        all: strategyCounts(rows, labels),
        ...(eligible ? { pass: strategyCounts(passed, labels) } : {}),
      },
      intersections: {
        all: intersections(rows, labels),
        ...(eligible ? { pass: intersections(passed, labels) } : {}),
      },
      queries: queryCoverage(run.catalog.queries, subqueries, hits),
      subqueries,
      ...(eligible && collection
        ? { byEligibility, unknownReasons, collection }
        : {}),
    };
    const coveragePath = join(outputDir, 'coverage.json');
    onProgress(3, 6, 'coverage.json');
    writeJson(coveragePath, coverage);
    const reportPath = join(outputDir, 'report.md');
    onProgress(4, 6, 'report.md');
    writeFileSync(
      reportPath,
      `${reportLines({ run, hits: hits.length, rows: rows.length, labels, coverage, byEligibility, unknownReasons, collection, observed }).join('\n')}\n`,
      'utf8',
    );
    const files = [candidatesPath, hitsPath, coveragePath, reportPath];
    const manifestPath = join(outputDir, 'manifest.json');
    onProgress(5, 6, 'manifest.json');
    const environment = environmentManifest();
    writeJson(manifestPath, {
      run,
      ...environment,
      versions: {
        ...environment.versions,
        evaluators: run.evaluatorVersions,
        snapshotEvaluators: EVALUATOR_VERSIONS,
      },
      sha256: Object.fromEntries(
        await Promise.all(
          files.map(async (f) => [f.split('/').at(-1), await sha256File(f)]),
        ),
      ),
    });
    onProgress(6, 6, '');
    return { files: [...files, manifestPath] };
  });
}

function intersectionLines(
  labels: Strategy[],
  overlap: Intersections,
): string[] {
  return [
    ...labels.map((label) => `- somente ${label}: ${overlap.exclusive[label]}`),
    ...overlap.pairs.map(
      ({ left, right, count }) => `- ${left} ∩ ${right}: ${count} repositórios`,
    ),
    ...(labels.length > 1
      ? [`- ${labels.join(' ∩ ')}: ${overlap.all} repositórios`]
      : []),
  ];
}

function reportLines(data: {
  run: Run;
  hits: number;
  rows: number;
  labels: Strategy[];
  coverage: RunCoverage;
  byEligibility: Record<ProtocolEvaluation['status'], number>;
  unknownReasons: Record<string, number>;
  collection: CollectionSummary | null;
  observed: ObservedCoverage[];
}): string[] {
  const { run, labels, coverage, collection } = data;
  const attention = coverage.subqueries.filter(
    (entry) => entry.state === 'partial' || entry.state === 'failed',
  );
  const pass = coverage.byStrategy.pass;
  return [
    '# Diagnóstico da descoberta',
    '',
    `Rodada: ${run.id}`,
    `Estado: ${run.state}`,
    `Início: ${run.startedAt}`,
    `Fim: ${run.endedAt ?? 'em andamento'}`,
    `Data de expansão das subconsultas: ${run.expansionDate}`,
    '',
    `Hits coletados: ${data.hits}. Repositórios distintos: ${data.rows}.`,
    '',
    '## Cobertura por consulta',
    '',
    '| Consulta | Estratégia | Subconsultas | Completas | Parciais | Falhas | Pendentes | Hits | Repositórios únicos |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...coverage.queries.map(
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
    '## Contagens por estratégia',
    '',
    pass ? '| Estratégia | pass | Todos |' : '| Estratégia | Todos |',
    pass ? '| --- | ---: | ---: |' : '| --- | ---: |',
    ...labels.map((label) =>
      pass
        ? `| ${label} | ${pass[label]} | ${coverage.byStrategy.all[label]} |`
        : `| ${label} | ${coverage.byStrategy.all[label]} |`,
    ),
    '',
    '## Interseções entre estratégias',
    '',
    ...(coverage.intersections.pass ? ['Todos os candidatos:', ''] : []),
    ...intersectionLines(labels, coverage.intersections.all),
    ...(coverage.intersections.pass
      ? [
          '',
          'Candidatos pass:',
          '',
          ...intersectionLines(labels, coverage.intersections.pass),
        ]
      : []),
    '',
    ...(collection ? eligibilityLines(data, collection) : []),
    '## Limitações',
    '',
    '- A indexação de busca pode ser incompleta, mudar durante a rodada e limitar cada consulta a 1.000 resultados; os totais não representam a população.',
    '- Busca de código considera somente a branch padrão e arquivos de até 384 KB. A busca exclui forks por padrão.',
    '- Contagens não são prevalência nem casos confirmados: a descoberta encontra candidatos e não determina se pertencem ao fenômeno pesquisado.',
    ...(collection
      ? [
          '- Branches e heads são observados em instantes distintos, sem snapshot global do GitHub. Um commit pode tornar-se visível após a observação de sua ref; inspectionUntil fixa o teto temporal, não a visibilidade das refs. Mudanças de heads durante paginação e refs criadas após enumeração não garantem cobertura retroativa.',
          '- Refs deleted (apagadas), históricos inacessíveis e refs de forks externos não são suportados. Cobertura negativa vale apenas para as refs e páginas observadas, não para todo o histórico possível.',
          '- O autor do commit, não o committer, determina autoria; committedDate define o intervalo UTC inclusivo. Autoria humana independe de merges, auto-merges, rebases e cherry-picks.',
          '- Custo de rate-limit e bytes indisponíveis permanecem nulos; contadores globais não permitem inferir custo por requisição.',
        ]
      : [
          '- Sem regras de elegibilidade não há coleta de metadados além da busca: candidatos encontrados só pela busca de código não trazem push, estrelas ou data de criação. Declare uma regra `last_push` para recortar por data e obter esses metadados.',
        ]),
    '',
  ];
}

/** Sections that exist only when the run's protocol has eligibility rules. */
function eligibilityLines(
  data: {
    byEligibility: Record<ProtocolEvaluation['status'], number>;
    unknownReasons: Record<string, number>;
    observed: ObservedCoverage[];
  },
  collection: CollectionSummary,
): string[] {
  const durations = collection.perCandidate
    .map((c) => c.activity.activeDurationMs)
    .sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const median = !durations.length
    ? 0
    : durations.length % 2
      ? (durations[middle] ?? 0)
      : ((durations[middle - 1] ?? 0) + (durations[middle] ?? 0)) / 2;
  const metrics = (kind: 'activity' | 'metadata') => {
    const m = collection[kind];
    return `- ${kind}: tentativas=${m.attempts}; retries=${m.retries}; bytes=${m.responseBytes ?? 'indisponível'}; espera=${m.waitMs} ms; duração ativa=${m.activeDurationMs} ms; custo rate-limit=${m.rateLimitCost ?? 'indisponível'}.`;
  };
  return [
    '## Elegibilidade',
    '',
    ...Object.entries(data.byEligibility).map(([s, n]) => `- ${s}: ${n}`),
    '',
    'Motivos de elegibilidade unknown (candidatos por motivo):',
    ...Object.entries(data.unknownReasons).map(
      ([reason, n]) => `- ${reason}: ${n}`,
    ),
    '',
    'pass indica atendimento ao protocolo. unknown permanece indeterminado e não é reprovação. Elegibilidade não confirma pertencimento ao fenômeno nem sua prevalência.',
    '',
    '## Coleta e custo',
    '',
    `Necessários: pending=${collection.required.pending}; failed=${collection.required.failed}; limited=${collection.required.limited}; pendingEvaluations=${collection.required.pendingEvaluations}.`,
    'Autoria indeterminada após cobertura completa é unknown terminal; não implica trabalho de rede pendente. Avaliações persistidas desatualizadas são reavaliadas somente sobre os fatos deste snapshot, sem gravar dados.',
    metrics('activity'),
    metrics('metadata'),
    `Duração ativa por candidato/invocação: mediana=${median} ms; máximo=${durations.at(-1) ?? 0} ms. Espera por rate-limit é medida separadamente e também integra a duração ativa.`,
    '',
    'Motivos atuais das tarefas de coleta (tarefas por motivo):',
    ...Object.entries(collection.unknownReasons).map(
      ([reason, n]) => `- ${reason}: ${n}`,
    ),
    'Limites registrados por invocação:',
    ...collection.invocations.map(
      (i) => `- ${i.id}: ${JSON.stringify(i.limits)}`,
    ),
    '',
    '## Intervalos e refs observadas',
    '',
    ...data.observed.flatMap((o) => [
      `- Repositório ${o.repositoryId}: inspectionUntil=${o.inspectionUntil ?? 'não iniciado'}`,
      ...o.coverage.flatMap((c) => [
        `  - ${c.request.branches}: ${c.request.since} até ${c.request.until}; ${c.state}; páginas=${c.pages}; motivo=${c.reason ?? ''}; evidências=${c.evidenceIds.join(',')}`,
        ...c.refs.map(
          (r) =>
            `  - ref=${r.name}; headSha=${r.headSha}; observedAt=${r.observedAt}`,
        ),
      ]),
    ]),
    '',
  ];
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
