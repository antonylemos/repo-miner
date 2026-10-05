import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../src/discovery/catalog.js';
import { expandCatalog } from '../src/discovery/expansion.js';

const catalog = parseCatalog(
  JSON.parse(
    readFileSync(
      new URL('../config/catalogs/micro-frontends.json', import.meta.url),
      'utf8',
    ),
  ),
);

describe('configured discovery catalog', () => {
  it('should declare the approved queries with the activity filter', () => {
    expect(catalog.filters.pushedSince).toBe('2024-01-01');
    expect(catalog.queries).toHaveLength(32);
    const count = (strategy: string) =>
      catalog.queries.filter((q) => q.strategy === strategy).length;
    expect(count('terminology')).toBe(8);
    expect(count('technology')).toBe(19);
    expect(count('broader')).toBe(5);
  });

  it('should not contain the removed version 1 queries', () => {
    const texts = catalog.queries.map((q) => q.q);
    expect(texts).not.toContain('micro-frontend in:name,description,readme');
    expect(texts).not.toContain('single-spa in:name,description,readme');
    expect(texts.some((q) => q.includes('in:file'))).toBe(false);
    expect(
      texts.some((q) =>
        /^"Web Components" in:name,description,readme$/i.test(q),
      ),
    ).toBe(false);
  });

  it('should expand into unique subqueries', () => {
    const subqueries = expandCatalog(catalog, '2026-10-05');
    expect(new Set(subqueries.map((s) => s.id)).size).toBe(subqueries.length);
    for (const subquery of subqueries) {
      if (subquery.endpoint === 'repositories')
        expect(subquery.q).toContain('pushed:>=2024-01-01');
      else expect(subquery.q).not.toContain('pushed:');
    }
  });
});
