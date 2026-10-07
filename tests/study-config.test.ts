import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/discovery/catalog.js';
import {
  parseStudyConfig,
  prepareSearchPlan,
} from '../src/discovery/study-config.js';

const query = (overrides = {}) => ({
  id: 'one',
  strategy: 'terminology',
  endpoint: 'repositories',
  q: 'microfrontend',
  rationale: 'test',
  ...overrides,
});
const catalog = {
  version: 3,
  queries: [query(), query({ id: 'code', endpoint: 'code' })],
};
const protocol = (eligibility: unknown[]) => ({ version: 1, eligibility });
const push = { id: 'push', type: 'last_push', since: '2025-04-01' };
describe('study config', () => {
  it('rejects_protocol_on_v2', () => {
    const legacy = {
      ...catalog,
      version: 2,
      filters: { pushedSince: '2025-04-01' },
    };
    expect(() => parseStudyConfig(legacy, protocol([]))).toThrow(
      /v3|version 3/i,
    );
    expect(
      prepareSearchPlan(parseStudyConfig(legacy), '2026-10-06')[0].q,
    ).toContain('pushed:>=2025-04-01');
  });
  it('rejects_filters_on_v3', () => {
    expect(() =>
      parseStudyConfig({
        version: 3,
        queries: [query({ id: 'one' })],
        filters: { pushedSince: '2025-04-01' },
      }),
    ).toThrow(/protocol/i);
  });
  it('omitted_protocol_equals_empty_protocol', () => {
    expect(parseStudyConfig(catalog)).toMatchObject({
      protocol: { version: 1, eligibility: [] },
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
  it('does_not_generate_push_filter_for_recent_commit', () => {
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
  it('generates_strictest_push_filter_for_conjunction', () => {
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
  it('hash_preserves_rule_and_query_order', () => {
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
  it('shares query and date validation', () => {
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
