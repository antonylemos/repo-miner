import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollectionSummary } from '../collectors/types.js';
import {
  EVALUATOR_VERSIONS,
  evaluateProtocol,
} from '../eligibility/evaluate.js';
import type {
  CandidateFacts,
  ProtocolEvaluation,
} from '../eligibility/types.js';
import type { ExportProgress } from '../report.js';
import type { ProtocolRun, ProtocolStore } from '../storage/protocol-store.js';
import type { Coverage, Strategy } from '../types.js';
import {
  compareHits,
  environmentManifest,
  exportedMetadata,
  HIT_COLUMNS,
  type Intersections,
  intersections,
  type QueryCoverage,
  queryCoverage,
  STRATEGIES,
  sha256File,
  strategiesByCandidate,
  strategyCounts,
  writeCsv,
} from './common.js';
export type ProtocolCoverage = {
  run: ProtocolRun;
  totals: { hits: number; uniqueCandidates: number };
  byEligibility: Record<ProtocolEvaluation['status'], number>;
  unknownReasons: Record<string, number>;
  byStrategy: {
    pass: Record<Strategy, number>;
    not_applied: Record<Strategy, number>;
    all: Record<Strategy, number>;
  };
  intersections: { pass: Intersections; not_applied: Intersections };
  queries: QueryCoverage[];
  subqueries: Coverage[];
  collection: CollectionSummary;
};
const COLUMNS = [
  'id',
  'full_name',
  'url',
  'eligibility_status',
  'eligibility_results_json',
  'evidence_json',
  'strategies',
  'metadata_json',
  'enrichment_json',
];
type SummaryRow = {
  id: number;
  strategies: Strategy[];
  status: ProtocolEvaluation['status'];
};
/** Every artifact, including the file hashes, is derived while this read transaction remains open. */
export async function exportProtocolRun(
  store: ProtocolStore,
  outputDir: string,
  onProgress: ExportProgress = () => {},
): Promise<{ files: string[] }> {
  return store.withReadSnapshot(async (snapshot) => {
    mkdirSync(outputDir, { recursive: true });
    onProgress(0, 6, 'lendo dados');
    const run = snapshot.getRun();
    const hits = snapshot.readHits();
    const subqueries = snapshot.readCoverage();
    const collection = snapshot.readCollectionSummary();
    const strategies = strategiesByCandidate(hits);
    const rows: SummaryRow[] = [];
    const observed: Array<{
      repositoryId: number;
      inspectionUntil: string | null;
      coverage: CandidateFacts['coverage'];
    }> = [];
    const unknownReasons: Record<string, number> = {};
    const byEligibility: ProtocolCoverage['byEligibility'] = {
      pass: 0,
      fail: 0,
      unknown: 0,
      not_applied: 0,
    };
    function* candidates(): Generator<unknown[]> {
      for (const candidate of snapshot.iterateCandidates()) {
        const facts = snapshot.readCandidateFacts(candidate.id);
        const recorded =
          candidate.evaluation !== null &&
          candidate.evaluationRevision === facts.revision;
        const evaluation = recorded
          ? (candidate.evaluation as ProtocolEvaluation)
          : evaluateProtocol(run.protocol, facts);
        const found = STRATEGIES.filter((s) =>
          strategies.get(candidate.id)?.has(s),
        );
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
          candidate.id,
          candidate.fullName,
          candidate.url,
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
          found.join(';'),
          JSON.stringify(exportedMetadata(candidate.metadata)),
          candidate.enrichment?.data
            ? JSON.stringify(candidate.enrichment.data)
            : '',
        ];
      }
    }
    const candidatesPath = join(outputDir, 'candidates.csv');
    onProgress(1, 6, 'candidates.csv');
    await writeCsv(candidatesPath, COLUMNS, candidates());
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
    const unapplied = rows.filter((r) => r.status === 'not_applied');
    const coverage: ProtocolCoverage = {
      run,
      totals: { hits: hits.length, uniqueCandidates: rows.length },
      byEligibility,
      unknownReasons,
      byStrategy: {
        pass: strategyCounts(passed),
        not_applied: strategyCounts(unapplied),
        all: strategyCounts(rows),
      },
      intersections: {
        pass: intersections(passed),
        not_applied: intersections(unapplied),
      },
      queries: queryCoverage(run.catalog.queries, subqueries, hits),
      subqueries,
      collection,
    };
    const coveragePath = join(outputDir, 'coverage.json');
    onProgress(3, 6, 'coverage.json');
    writeJson(coveragePath, coverage);
    const reportPath = join(outputDir, 'report.md');
    onProgress(4, 6, 'report.md');
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
    writeFileSync(
      reportPath,
      [
        '# Diagnóstico da descoberta e elegibilidade',
        '',
        `Rodada: ${run.id}`,
        `Estado: ${run.state}`,
        `Início: ${run.startedAt}`,
        `Fim: ${run.endedAt ?? 'em andamento'}`,
        `Data de expansão das subconsultas: ${run.expansionDate}`,
        '',
        `Hits coletados: ${hits.length}. Repositórios distintos: ${rows.length}.`,
        '',
        '## Elegibilidade',
        '',
        ...Object.entries(byEligibility).map(([s, n]) => `- ${s}: ${n}`),
        '',
        'Motivos de elegibilidade unknown (candidatos por motivo):',
        ...Object.entries(unknownReasons).map(
          ([reason, n]) => `- ${reason}: ${n}`,
        ),
        '',
        'pass indica atendimento ao protocolo; not_applied indica protocolo sem regras. unknown permanece indeterminado e não é reprovação. Elegibilidade não confirma pertencimento ao fenômeno nem sua prevalência.',
        '',
        '## Cobertura por consulta',
        '',
        '| Consulta | Estratégia | Completas | Parciais | Falhas | Pendentes | Hits | Repositórios únicos |',
        '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...coverage.queries.map(
          (q) =>
            `| ${q.queryId} | ${q.strategy} | ${q.complete} | ${q.partial} | ${q.failed} | ${q.pending} | ${q.hits} | ${q.uniqueCandidates} |`,
        ),
        '',
        '## Estratégias',
        '',
        '| Estratégia | pass | not_applied | Todos |',
        '| --- | ---: | ---: | ---: |',
        ...STRATEGIES.map(
          (s) =>
            `| ${s} | ${coverage.byStrategy.pass[s]} | ${coverage.byStrategy.not_applied[s]} | ${coverage.byStrategy.all[s]} |`,
        ),
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
        ...observed.flatMap((o) => [
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
        '## Limitações',
        '',
        '- A indexação de busca pode ser incompleta, mudar durante a rodada e limitar cada consulta a 1.000 resultados; os totais não representam a população.',
        '- Busca de código considera somente a branch padrão e arquivos de até 384 KB. A busca exclui forks por padrão.',
        '- Branches e heads são observados em instantes distintos, sem snapshot global do GitHub. Um commit pode tornar-se visível após a observação de sua ref; inspectionUntil fixa o teto temporal, não a visibilidade das refs. Mudanças de heads durante paginação e refs criadas após enumeração não garantem cobertura retroativa.',
        '- Refs deleted (apagadas), históricos inacessíveis e refs de forks externos não são suportados. Cobertura negativa vale apenas para as refs e páginas observadas, não para todo o histórico possível.',
        '- O autor do commit, não o committer, determina autoria; committedDate define o intervalo UTC inclusivo. Autoria humana independe de merges, auto-merges, rebases e cherry-picks.',
        '- Custo de rate-limit e bytes indisponíveis permanecem nulos; contadores globais não permitem inferir custo por requisição.',
        '',
      ].join('\n'),
      'utf8',
    );
    const files = [candidatesPath, hitsPath, coveragePath, reportPath];
    const manifestPath = join(outputDir, 'manifest.json');
    onProgress(5, 6, 'manifest.json');
    const environment = environmentManifest();
    writeJson(manifestPath, {
      schemaVersion: 3,
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
function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
