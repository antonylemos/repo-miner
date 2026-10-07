import { describe, expect, it } from 'vitest';
import { catalogHash, parseQueries } from '../src/discovery/catalog.js';

const valid = {
  queries: [
    {
      id: 't-repositories',
      strategy: 'terminology',
      endpoint: 'repositories',
      q: '"micro frontend" in:name,description,readme',
      rationale: 'Explicit MFE term.',
      partition: { by: 'created', from: '2019-01-01', interval: 'month' },
    },
    {
      id: 'tech-code',
      strategy: 'technology',
      endpoint: 'code',
      q: '"@module-federation" filename:package.json',
      rationale: 'Declared dependency.',
      partition: { by: 'size', bounds: [0, 1000, 2000] },
    },
    {
      id: 'broad-repositories',
      strategy: 'broader',
      endpoint: 'repositories',
      q: '"frontend composition" in:name,description,readme',
      rationale: 'Broader composition term.',
    },
  ],
};

function withQuery(overrides: Record<string, unknown>) {
  return [{ ...valid.queries[2], ...overrides }];
}

describe('catalog', () => {
  it('should accept queries with both partition kinds', () => {
    expect(parseQueries(valid.queries)).toEqual(valid.queries);
  });

  it('should omit the partition key when a query has none', () => {
    expect('partition' in parseQueries(valid.queries)[2]).toBe(false);
  });

  it.each(['package-manifest', 'readme_terms', 'a', 'tier2'])(
    'should accept the free strategy label %s',
    (strategy) => {
      expect(parseQueries(withQuery({ strategy }))[0].strategy).toBe(strategy);
    },
  );

  it.each([
    '',
    'two words',
    'Terminology',
    'a;b',
    'a|b',
    '-leading',
    'trailing-',
    'double--dash',
    undefined,
    7,
  ])('should reject the strategy %j and cite the query id', (strategy) => {
    expect(() => parseQueries(withQuery({ strategy }))).toThrow(
      /"broad-repositories".*strategy/,
    );
  });

  it('should reject invalid queries', () => {
    for (const queries of [
      [valid.queries[2], valid.queries[2]],
      [{ ...valid.queries[2], q: ' ' }],
      [{ ...valid.queries[2], endpoint: 'users' }],
      [{ ...valid.queries[2], rationale: '' }],
      [{ id: 'x', endpoint: 'repositories', q: 'x', rationale: 'x' }],
    ])
      expect(() => parseQueries(queries)).toThrow();
  });

  it('should reject reserved qualifiers in any case or negation', () => {
    for (const q of [
      'x pushed:>=2024-01-01',
      'x Pushed:>2024',
      'x -created:<2020-01-01',
      'size:10..20 x',
    ])
      expect(() => parseQueries(withQuery({ q }))).toThrow(/reserved/);
  });

  it('should restrict partitions to their endpoint', () => {
    expect(() =>
      parseQueries(
        withQuery({
          endpoint: 'code',
          partition: { by: 'created', from: '2019-01-01', interval: 'year' },
        }),
      ),
    ).toThrow(/repositories/);
    expect(() =>
      parseQueries(withQuery({ partition: { by: 'size', bounds: [0, 10] } })),
    ).toThrow(/code/);
  });

  it('should require created partitions to start a period', () => {
    for (const partition of [
      { by: 'created', from: '2019-01-02', interval: 'month' },
      { by: 'created', from: '2019-02-01', interval: 'quarter' },
      { by: 'created', from: '2019-04-01', interval: 'year' },
      { by: 'created', from: '2019-01-01', interval: 'week' },
    ])
      expect(() => parseQueries(withQuery({ partition }))).toThrow();
  });

  it('should require increasing size bounds starting at zero', () => {
    for (const bounds of [[0], [1, 10], [0, 10, 10], [0, 1.5], 'x'])
      expect(() =>
        parseQueries(
          withQuery({ endpoint: 'code', partition: { by: 'size', bounds } }),
        ),
      ).toThrow(/bounds/);
  });

  it('should hash canonical JSON while preserving query order', () => {
    const reordered = valid.queries.map((query) =>
      Object.fromEntries(Object.entries(query).reverse()),
    );
    expect(catalogHash({ queries: parseQueries(valid.queries) })).toBe(
      catalogHash({ queries: parseQueries(reordered) }),
    );
    expect(catalogHash({ queries: parseQueries(valid.queries) })).not.toBe(
      catalogHash({ queries: parseQueries([...valid.queries].reverse()) }),
    );
  });
});
