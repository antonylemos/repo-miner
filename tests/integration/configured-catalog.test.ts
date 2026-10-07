import { readFileSync } from 'node:fs';
import { projectFile } from '@tests/helpers.js';
import { describe, expect, it } from 'vitest';
import {
  parseStudyConfig,
  prepareSearchPlan,
} from '@/modules/discovery/study/config.js';

const config = parseStudyConfig(
  JSON.parse(
    readFileSync(projectFile('config/catalogs/micro-frontends.json'), 'utf8'),
  ),
  JSON.parse(
    readFileSync(projectFile('config/protocols/micro-frontends.json'), 'utf8'),
  ),
);
const catalog = config.catalog;

describe('configured discovery catalog', () => {
  it('should declare approved queries separately from the human activity protocol', () => {
    expect(Object.keys(config.catalog)).toEqual(['queries']);
    expect(config.protocol.eligibility).toEqual([
      { id: 'recent-push', type: 'last_push', since: '2025-04-01' },
      {
        id: 'recent-human-commit',
        type: 'recent_commit',
        since: '2025-04-01',
        dateField: 'committedDate',
        branches: 'all',
        authors: 'human',
      },
    ]);
    expect(catalog.queries).toHaveLength(28);
    const count = (strategy: string) =>
      catalog.queries.filter((q) => q.strategy === strategy).length;
    expect(count('terminology')).toBe(8);
    expect(count('technology')).toBe(15);
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

  it('should restrict technology queries to Module Federation, single-spa and Web Components', () => {
    const texts = catalog.queries.map((q) => q.q);
    expect(texts.some((q) => /qiankun|wujie|micro-zoe|piral/i.test(q))).toBe(
      false,
    );
    expect(texts).toContain('"web components" microfrontends in:readme');
  });

  it('should expand into unique subqueries', () => {
    const subqueries = prepareSearchPlan(config, '2026-10-05');
    expect(new Set(subqueries.map((s) => s.id)).size).toBe(subqueries.length);
    for (const subquery of subqueries) {
      if (subquery.endpoint === 'repositories') {
        expect(subquery.q).toContain('pushed:>=2025-04-01');
      } else {
        expect(subquery.q).not.toContain('pushed:');
      }
    }
  });
});
