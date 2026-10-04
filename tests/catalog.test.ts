import { describe, expect, it } from 'vitest';
import { catalogHash, parseCatalog } from '../src/discovery/catalog.js';

const valid = {
  version: 1,
  queries: [
    {
      id: 't-repositories',
      strategy: 'terminology',
      endpoint: 'repositories',
      q: 'microfrontend in:name,description,readme',
    },
    {
      id: 'tech-code',
      strategy: 'technology',
      endpoint: 'code',
      q: '"Module Federation" in:file',
    },
    {
      id: 'broad-repositories',
      strategy: 'broader',
      endpoint: 'repositories',
      q: '"frontend composition" in:name,description,readme',
    },
  ],
};

describe('catalog', () => {
  it('should accept all three search strategies', () =>
    expect(parseCatalog(valid)).toEqual(valid));

  it('should reject invalid queries', () => {
    for (const queries of [
      [valid.queries[0], valid.queries[0]],
      [{ ...valid.queries[0], q: ' ' }],
      [{ ...valid.queries[0], endpoint: 'users' }],
      [{ id: 'x', endpoint: 'repositories', q: 'x' }],
    ])
      expect(() => parseCatalog({ version: 1, queries })).toThrow();
  });

  it('should hash canonical JSON while preserving query order', () => {
    const a = {
      version: 1,
      queries: [{ id: 'x', strategy: 'broader', endpoint: 'code', q: 'x' }],
    };
    const b = {
      queries: [{ q: 'x', endpoint: 'code', strategy: 'broader', id: 'x' }],
      version: 1,
    };
    expect(catalogHash(parseCatalog(a))).toBe(catalogHash(parseCatalog(b)));
    expect(catalogHash(parseCatalog(a))).not.toBe(
      catalogHash(
        parseCatalog({ ...a, queries: [{ ...a.queries[0], q: 'y' }] }),
      ),
    );
  });
});
