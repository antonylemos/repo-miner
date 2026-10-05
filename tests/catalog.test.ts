import { describe, expect, it } from 'vitest';
import { catalogHash, parseCatalog } from '../src/discovery/catalog.js';

const valid = {
  version: 2,
  filters: { pushedSince: '2024-01-01' },
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
  return { ...valid, queries: [{ ...valid.queries[2], ...overrides }] };
}

describe('catalog', () => {
  it('should accept a version 2 catalog with both partition kinds', () => {
    expect(parseCatalog(valid)).toEqual(valid);
  });

  it('should omit the partition key when a query has none', () => {
    expect('partition' in parseCatalog(valid).queries[2]).toBe(false);
  });

  it('should reject a version 1 catalog', () => {
    expect(() => parseCatalog({ version: 1, queries: valid.queries })).toThrow(
      /version 2/,
    );
  });

  it('should require a valid pushedSince filter', () => {
    for (const filters of [
      undefined,
      {},
      { pushedSince: '2024-13-01' },
      { pushedSince: '2024-1-1' },
    ])
      expect(() => parseCatalog({ ...valid, filters })).toThrow(/pushedSince/);
  });

  it('should reject invalid queries', () => {
    for (const queries of [
      [valid.queries[2], valid.queries[2]],
      [{ ...valid.queries[2], q: ' ' }],
      [{ ...valid.queries[2], endpoint: 'users' }],
      [{ ...valid.queries[2], rationale: '' }],
      [{ id: 'x', endpoint: 'repositories', q: 'x', rationale: 'x' }],
    ])
      expect(() => parseCatalog({ ...valid, queries })).toThrow();
  });

  it('should reject reserved qualifiers in any case or negation', () => {
    for (const q of [
      'x pushed:>=2024-01-01',
      'x Pushed:>2024',
      'x -created:<2020-01-01',
      'size:10..20 x',
    ])
      expect(() => parseCatalog(withQuery({ q }))).toThrow(/reserved/);
  });

  it('should restrict partitions to their endpoint', () => {
    expect(() =>
      parseCatalog(
        withQuery({
          endpoint: 'code',
          partition: { by: 'created', from: '2019-01-01', interval: 'year' },
        }),
      ),
    ).toThrow(/repositories/);
    expect(() =>
      parseCatalog(withQuery({ partition: { by: 'size', bounds: [0, 10] } })),
    ).toThrow(/code/);
  });

  it('should require created partitions to start a period', () => {
    for (const partition of [
      { by: 'created', from: '2019-01-02', interval: 'month' },
      { by: 'created', from: '2019-02-01', interval: 'quarter' },
      { by: 'created', from: '2019-04-01', interval: 'year' },
      { by: 'created', from: '2019-01-01', interval: 'week' },
    ])
      expect(() => parseCatalog(withQuery({ partition }))).toThrow();
  });

  it('should require increasing size bounds starting at zero', () => {
    for (const bounds of [[0], [1, 10], [0, 10, 10], [0, 1.5], 'x'])
      expect(() =>
        parseCatalog(
          withQuery({ endpoint: 'code', partition: { by: 'size', bounds } }),
        ),
      ).toThrow(/bounds/);
  });

  it('should hash canonical JSON while preserving query order', () => {
    const reordered = {
      queries: valid.queries.map((query) =>
        Object.fromEntries(Object.entries(query).reverse()),
      ),
      filters: valid.filters,
      version: 2,
    };
    expect(catalogHash(parseCatalog(valid))).toBe(
      catalogHash(parseCatalog(reordered)),
    );
    expect(catalogHash(parseCatalog(valid))).not.toBe(
      catalogHash(
        parseCatalog({ ...valid, queries: [...valid.queries].reverse() }),
      ),
    );
  });
});
