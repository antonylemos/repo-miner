import { describe, expect, it } from 'vitest';
import type { Query } from '@/modules/discovery/model/search.js';
import { expandQueries } from '@/modules/discovery/study/expansion.js';

const PUSH_QUALIFIER = 'pushed:>=2024-01-01';

function catalogWith(query: Partial<Query>): { queries: Query[] } {
  return {
    queries: [
      {
        id: 'q',
        strategy: 'terminology',
        endpoint: 'repositories',
        q: '"micro frontend" in:readme',
        rationale: 'test',
        ...query,
      },
    ],
  };
}

function expandCatalog(
  catalog: { queries: Query[] },
  expansionDate: string,
  qualifier: string | null = PUSH_QUALIFIER,
) {
  return expandQueries(catalog.queries, expansionDate, qualifier);
}

describe('expandQueries', () => {
  it('should keep an unpartitioned repository query as one subquery with the push filter', () => {
    expect(expandCatalog(catalogWith({}), '2026-10-05')).toEqual([
      {
        id: 'q',
        queryId: 'q',
        strategy: 'terminology',
        endpoint: 'repositories',
        q: '"micro frontend" in:readme pushed:>=2024-01-01',
        partitionLabel: '',
      },
    ]);
  });

  it('should not add the push filter to code queries', () => {
    const [subquery] = expandCatalog(
      catalogWith({ endpoint: 'code', q: 'single-spa filename:package.json' }),
      '2026-10-05',
    );
    expect(subquery.q).toBe('single-spa filename:package.json');
  });

  it('should split monthly with a leading bucket and an open final interval', () => {
    const subqueries = expandCatalog(
      catalogWith({
        partition: { by: 'created', from: '2026-08-01', interval: 'month' },
      }),
      '2026-10-05',
    );
    expect(subqueries.map(({ id, q }) => [id, q])).toEqual([
      [
        'q#created:<2026-08-01',
        '"micro frontend" in:readme pushed:>=2024-01-01 created:<2026-08-01',
      ],
      [
        'q#created:2026-08',
        '"micro frontend" in:readme pushed:>=2024-01-01 created:2026-08-01..2026-08-31',
      ],
      [
        'q#created:2026-09',
        '"micro frontend" in:readme pushed:>=2024-01-01 created:2026-09-01..2026-09-30',
      ],
      [
        'q#created:>=2026-10-01',
        '"micro frontend" in:readme pushed:>=2024-01-01 created:>=2026-10-01',
      ],
    ]);
  });

  it('should label quarters and years', () => {
    const quarters = expandCatalog(
      catalogWith({
        partition: { by: 'created', from: '2025-01-01', interval: 'quarter' },
      }),
      '2025-08-15',
    );
    expect(quarters.map((s) => s.partitionLabel)).toEqual([
      'created:<2025-01-01',
      'created:2025-Q1',
      'created:2025-Q2',
      'created:>=2025-07-01',
    ]);
    expect(quarters[2].q).toContain('created:2025-04-01..2025-06-30');

    const years = expandCatalog(
      catalogWith({
        partition: { by: 'created', from: '2024-01-01', interval: 'year' },
      }),
      '2026-03-01',
    );
    expect(years.map((s) => s.partitionLabel)).toEqual([
      'created:<2024-01-01',
      'created:2024',
      'created:2025',
      'created:>=2026-01-01',
    ]);
    expect(years[1].q).toContain('created:2024-01-01..2024-12-31');
  });

  it('should treat an expansion date on the first day of a period as the open interval', () => {
    const subqueries = expandCatalog(
      catalogWith({
        partition: { by: 'created', from: '2026-09-01', interval: 'month' },
      }),
      '2026-10-01',
    );
    expect(subqueries.map((s) => s.partitionLabel)).toEqual([
      'created:<2026-09-01',
      'created:2026-09',
      'created:>=2026-10-01',
    ]);
  });

  it('should open at the start date when it is in the future', () => {
    const subqueries = expandCatalog(
      catalogWith({
        partition: { by: 'created', from: '2027-01-01', interval: 'month' },
      }),
      '2026-10-05',
    );
    expect(subqueries.map((s) => s.partitionLabel)).toEqual([
      'created:<2027-01-01',
      'created:>=2027-01-01',
    ]);
  });

  it('should split code queries by size ranges', () => {
    const subqueries = expandCatalog(
      catalogWith({
        endpoint: 'code',
        q: 'x',
        partition: { by: 'size', bounds: [0, 1000, 2000] },
      }),
      '2026-10-05',
    );
    expect(subqueries.map(({ id, q }) => [id, q])).toEqual([
      ['q#size:0..999', 'x size:0..999'],
      ['q#size:1000..1999', 'x size:1000..1999'],
      ['q#size:>=2000', 'x size:>=2000'],
    ]);
  });

  it('should be deterministic and preserve catalog order', () => {
    const catalog = {
      ...catalogWith({}),
      queries: [
        catalogWith({ id: 'b' }).queries[0],
        catalogWith({
          id: 'a',
          partition: { by: 'created', from: '2026-09-01', interval: 'month' },
        }).queries[0],
      ],
    };
    const first = expandCatalog(catalog, '2026-10-05');
    expect(expandCatalog(catalog, '2026-10-05')).toEqual(first);
    expect(first.map((s) => s.queryId)).toEqual(['b', 'a', 'a', 'a']);
  });

  it('should reject an invalid expansion date', () => {
    expect(() => expandCatalog(catalogWith({}), '05/10/2026')).toThrow(
      /expansion date/,
    );
  });
});
