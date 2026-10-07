import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@/common/canonical-json.js';
import { catalogHash } from '@/modules/discovery/study/catalog.js';
import {
  parseStudyConfig,
  prepareSearchPlan,
} from '@/modules/discovery/study/config.js';

const query = (overrides = {}) => ({
  id: 'one',
  strategy: 'terminology',
  endpoint: 'repositories',
  q: 'microfrontend',
  rationale: 'test',
  ...overrides,
});
const catalog = {
  queries: [query(), query({ id: 'code', endpoint: 'code' })],
};
const protocol = (eligibility: unknown[]) => ({ eligibility });
const push = { id: 'push', type: 'last_push', since: '2025-04-01' };
describe('study config', () => {
  it('should accept a catalog that only declares queries', () => {
    expect(parseStudyConfig(catalog).catalog).toEqual(catalog);
  });
  it('should ignore fields of an old catalog and keep only the queries', () => {
    expect(
      parseStudyConfig({
        ...catalog,
        version: 2,
        filters: { pushedSince: '2025-04-01' },
      }).catalog,
    ).toEqual(catalog);
  });
  it.each([null, [], 'catalog', {}, { queries: 'x' }])(
    'should reject a catalog without a queries array: %j',
    (input) => {
      expect(() => parseStudyConfig(input)).toThrow(/Invalid catalog/);
    },
  );
  it('should treat an omitted protocol as an empty protocol', () => {
    expect(parseStudyConfig(catalog)).toMatchObject({
      protocol: { eligibility: [] },
    });
    expect(parseStudyConfig(catalog)).toEqual(
      parseStudyConfig(catalog, protocol([])),
    );
    expect(
      prepareSearchPlan(parseStudyConfig(catalog), '2026-10-06').every(
        (s) => !s.q.includes('pushed:'),
      ),
    ).toBe(true);
  });
  it('should not generate push filter for recent commit', () => {
    const config = parseStudyConfig(
      catalog,
      protocol([
        {
          id: 'human',
          type: 'recent_commit',
          since: '2025-04-01',
          dateField: 'committedDate',
          branches: 'all',
          authors: 'human',
        },
      ]),
    );
    expect(
      prepareSearchPlan(config, '2026-10-06').every(
        (s) => !s.q.includes('pushed:'),
      ),
    ).toBe(true);
  });
  it('should generate strictest push filter for conjunction', () => {
    const plan = prepareSearchPlan(
      parseStudyConfig(
        catalog,
        protocol([push, { ...push, id: 'later', since: '2025-06-01' }]),
      ),
      '2026-10-06',
    );
    expect(plan[0].q).toBe('microfrontend pushed:>=2025-06-01');
    expect(plan[1].q).toBe('microfrontend');
  });
  it('should hash the canonical queries only', () => {
    const parsed = parseStudyConfig(catalog).catalog;
    expect(catalogHash(parsed)).toBe(
      createHash('sha256')
        .update(canonicalJson({ queries: parsed.queries }))
        .digest('hex'),
    );
  });
  it('should preserve rule and query order in the hash', () => {
    const first = parseStudyConfig(catalog);
    expect(canonicalJson(first)).not.toBe(
      canonicalJson(
        parseStudyConfig({
          ...catalog,
          queries: [...catalog.queries].reverse(),
        }),
      ),
    );
  });
  it('should share query and date validation', () => {
    for (const queries of [
      [],
      [query(), query()],
      [
        query({
          partition: { by: 'created', from: '2025-02-29', interval: 'month' },
        }),
      ],
    ])
      expect(() => parseStudyConfig({ ...catalog, queries })).toThrow();
    expect(() =>
      prepareSearchPlan(parseStudyConfig(catalog), '2025-02-29'),
    ).toThrow(/expansion date/);
  });
});
