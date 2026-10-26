import { describe, expect, it } from 'vitest';
import { renderReport } from '@/modules/profile/report.js';
import { summarize } from '@/modules/profile/statistics.js';

const context = {
  version: '1',
  repositories: 4,
  acquisition: 'data/acquisitions/a',
  referenceFrom: '2026-10-12T00:00:00.000Z',
  referenceTo: '2026-10-12T01:00:00.000Z',
};

describe('renderReport', () => {
  it('should show the numeric variables with their quantiles and empties', () => {
    const report = renderReport({
      ...context,
      summaries: [summarize('stars', ['1', '2', '3', '10', ''])],
    });
    expect(report).toContain(
      '| Variável | n | Vazios | Mediana | Q1 | Q3 | IQR | Mínimo | Máximo |',
    );
    expect(report).toContain(
      '| stars | 4 | 1 | 2.5 | 1.75 | 4.75 | 3 | 1 | 10 |',
    );
  });

  it('should show n and percent per category', () => {
    const report = renderReport({
      ...context,
      summaries: [summarize('domain', ['a', 'a', 'b', ''])],
    });
    expect(report).toContain('## domain');
    expect(report).toContain('n = 3; vazios = 1.');
    expect(report).toContain('| a | 2 | 66.67 |');
    expect(report).toContain('| b | 1 | 33.33 |');
    expect(report).not.toContain('não somam');
  });

  it('should warn that the percentages of a multi-value variable do not add up', () => {
    const report = renderReport({
      ...context,
      summaries: [summarize('types', ['a;b', 'a'])],
    });
    expect(report).toContain('os percentuais não somam 100%');
    expect(report).toContain('| a | 2 | 100 |');
  });

  it('should escape a pipe in a category', () => {
    const report = renderReport({
      ...context,
      summaries: [summarize('x', ['a|b'])],
    });
    expect(report).toContain('| a\\|b | 1 | 100 |');
  });

  it('should say when a variable has no values', () => {
    const report = renderReport({
      ...context,
      summaries: [summarize('x', [''])],
    });
    expect(report).toContain('Sem valores.');
  });

  it('should name the inputs and end with a single line break', () => {
    const report = renderReport({ ...context, summaries: [] });
    expect(report).toContain('Aquisição: data/acquisitions/a');
    expect(report).toContain('Repositórios: 4');
    expect(report).toContain('Nenhuma variável numérica.');
    expect(report.endsWith('\n')).toBe(true);
    expect(report.endsWith('\n\n')).toBe(false);
  });
});
