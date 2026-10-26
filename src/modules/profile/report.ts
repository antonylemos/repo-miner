import {
  type CategorySummary,
  formatNumber,
  type NumericSummary,
  type VariableSummary,
} from './statistics.js';

export type ReportContext = {
  version: string;
  repositories: number;
  acquisition: string;
  /** Earliest and latest reference instant. */
  referenceFrom: string;
  referenceTo: string;
  summaries: VariableSummary[];
};

function numericTable(summaries: NumericSummary[]): string[] {
  return [
    '| Variável | n | Vazios | Mediana | Q1 | Q3 | IQR | Mínimo | Máximo |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...summaries.map(
      (summary) =>
        `| ${summary.name} | ${summary.n} | ${summary.empty} | ${[
          summary.median,
          summary.q1,
          summary.q3,
          summary.iqr,
          summary.min,
          summary.max,
        ]
          .map(formatNumber)
          .join(' | ')} |`,
    ),
  ];
}

function categoryTable(summary: CategorySummary): string[] {
  const lines = [
    `## ${summary.name}`,
    '',
    `n = ${summary.n}; vazios = ${summary.empty}.`,
    '',
  ];
  if (summary.multiple)
    lines.push(
      'Cada repositório conta em todos os valores que tem; os percentuais não somam 100%.',
      '',
    );
  if (summary.categories.length === 0) return [...lines, 'Sem valores.', ''];
  return [
    ...lines,
    '| Valor | n | % |',
    '| --- | ---: | ---: |',
    ...summary.categories.map(
      (category) =>
        `| ${category.value.replaceAll('|', '\\|')} | ${category.n} | ${formatNumber(category.percent)} |`,
    ),
    '',
  ];
}

/** The statistical summary as Markdown; it holds nothing that changes between runs on the same inputs. */
export function renderReport(context: ReportContext): string {
  const numeric = context.summaries.filter(
    (summary): summary is NumericSummary => summary.kind === 'numeric',
  );
  const categorical = context.summaries.filter(
    (summary): summary is CategorySummary => summary.kind === 'categorical',
  );
  const lines = [
    '# Perfil dos repositórios',
    '',
    `Versão: ${context.version}`,
    `Aquisição: ${context.acquisition}`,
    `Repositórios: ${context.repositories}`,
    `Data de referência: a data do clone de cada repositório, de ${context.referenceFrom} a ${context.referenceTo}.`,
    '',
    'Quantis por interpolação linear entre as posições ordenadas; IQR = Q3 − Q1. Os vazios ficam fora de n.',
    '',
    '## Variáveis numéricas',
    '',
    ...(numeric.length > 0
      ? numericTable(numeric)
      : ['Nenhuma variável numérica.']),
    '',
    ...categorical.flatMap(categoryTable),
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}
