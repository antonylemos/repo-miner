import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hit, page, parseCsv, query } from '@tests/helpers.js';
import { afterEach, expect, test } from 'vitest';
import { DEFAULT_COLLECTION_LIMITS } from '@/modules/discovery/collection/limits.js';
import { evaluateProtocol } from '@/modules/discovery/eligibility/evaluate.js';
import type { FactRequest } from '@/modules/discovery/model/facts.js';
import type { DiscoveryStore } from '@/modules/discovery/model/store.js';
import type { Protocol } from '@/modules/discovery/model/study.js';
import { exportRun } from '@/modules/discovery/report/export.js';
import { openStore } from '@/modules/discovery/storage/store.js';

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing fixture');
  return value;
}
const stores: DiscoveryStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => {
    s.close();
  });
  dirs.splice(0).forEach((d) => {
    rmSync(d, { recursive: true, force: true });
  });
});
const protocol: Protocol = {
  eligibility: [
    {
      id: 'recent',
      type: 'recent_commit',
      since: '2025-01-01',
      dateField: 'committedDate',
      branches: 'all',
      authors: 'human',
    },
  ],
};
function setup(p = protocol) {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-report-'));
  dirs.push(dir);
  const path = join(dir, 'run.db');
  const store = openStore(path);
  stores.push(store);
  const sub = {
    id: 'q',
    queryId: 'q',
    strategy: 'terminology' as const,
    endpoint: 'repositories' as const,
    q: 'q',
    partitionLabel: '',
  };
  store.createRun({
    config: {
      catalog: { queries: [query({ id: 'q' })] },
      protocol: p,
    },
    subqueries: [sub],
    startedAt: '2026-10-06T00:00:00Z',
    expansionDate: '2026-10-06',
    limits: DEFAULT_COLLECTION_LIMITS,
  });
  store.savePage(
    sub,
    1,
    page([hit(1)]),
    { subqueryId: 'q', nextPage: null, state: 'complete' },
    '2026-10-06T00:00:00Z',
  );
  return { store, dir, path };
}
function activity(store: DiscoveryStore, author: 'User' | null | 'none') {
  const until = '2026-10-06T12:00:00Z';
  store.beginInspection(1, until);
  const request: FactRequest = {
    kind: 'commit_history',
    repositoryId: 1,
    since: '2025-01-01T00:00:00Z',
    until,
    branches: 'all',
  };
  store.syncTasks(1, [request]);
  const task = required(store.readTasks()[0]);
  store.saveCollectionStep(task, {
    repositoryObservations: [],
    refs: [{ name: 'main', headSha: 'sha', observedAt: until }],
    commits:
      author === 'none'
        ? []
        : [
            {
              repositoryId: 1,
              sha: 'sha',
              authoredDate: until,
              committedDate: until,
              observedAt: until,
              author: {
                name: 'A',
                email: null,
                account: author ? { login: 'a', providerType: author } : null,
              },
              committer: { name: 'A', email: null, account: null },
            },
          ],
    response: { requestUrl: 'url', observedAt: until, raw: [] },
    checkpoint: null,
    state: 'complete',
    reason: null,
  });
  const facts = store.readCandidateFacts(1);
  store.saveEvaluation(1, evaluateProtocol(protocol, facts), facts.revision);
}
function json(dir: string, name: string) {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}
function rows(dir: string) {
  const [header, ...data] = parseCsv(
    readFileSync(join(dir, 'candidates.csv'), 'utf8'),
  );
  return data.map((r) =>
    Object.fromEntries(required(header).map((k, i) => [k, r[i]])),
  );
}
const ELIGIBILITY_HEADINGS = [
  '## Elegibilidade',
  '## Coleta e custo',
  '## Intervalos e refs observadas',
];
test('should export no eligibility columns, keys or sections for an empty protocol', async () => {
  const { store, dir } = setup({ eligibility: [] });
  await exportRun(store, dir);
  const [header] = parseCsv(readFileSync(join(dir, 'candidates.csv'), 'utf8'));
  expect(header).toEqual([
    'id',
    'full_name',
    'url',
    'strategies',
    'metadata_json',
  ]);
  const coverage = json(dir, 'coverage.json');
  expect(Object.keys(coverage).sort()).toEqual([
    'byStrategy',
    'intersections',
    'queries',
    'run',
    'subqueries',
    'totals',
  ]);
  expect(Object.keys(coverage.byStrategy)).toEqual(['all']);
  expect(Object.keys(coverage.intersections)).toEqual(['all']);
  const report = readFileSync(join(dir, 'report.md'), 'utf8');
  for (const heading of ELIGIBILITY_HEADINGS)
    expect(report).not.toContain(heading);
  expect(report).toContain('## Cobertura por consulta');
  expect(report).toContain('## Interseções entre estratégias');
  expect(report).not.toContain('not_applied');
});
test('should export eligibility columns, keys and sections for a protocol with rules', async () => {
  const { store, dir } = setup();
  await exportRun(store, dir);
  const [header] = parseCsv(readFileSync(join(dir, 'candidates.csv'), 'utf8'));
  expect(header).toEqual([
    'id',
    'full_name',
    'url',
    'eligibility_status',
    'eligibility_results_json',
    'evidence_json',
    'strategies',
    'metadata_json',
  ]);
  const coverage = json(dir, 'coverage.json');
  expect(Object.keys(coverage).sort()).toEqual([
    'byEligibility',
    'byStrategy',
    'collection',
    'intersections',
    'queries',
    'run',
    'subqueries',
    'totals',
    'unknownReasons',
  ]);
  expect(Object.keys(coverage.byStrategy).sort()).toEqual(['all', 'pass']);
  expect(Object.keys(coverage.intersections).sort()).toEqual(['all', 'pass']);
  const report = readFileSync(join(dir, 'report.md'), 'utf8');
  for (const heading of ELIGIBILITY_HEADINGS) expect(report).toContain(heading);
});
test('should record auditable manifest hashes and version records', async () => {
  const { store, dir } = setup({ eligibility: [] });
  const result = await exportRun(store, dir);
  const manifest = json(dir, 'manifest.json');
  expect(manifest.run.protocolHash).toBe(store.getRun().protocolHash);
  expect(manifest.versions.evaluators).toEqual(
    store.getRun().evaluatorVersions,
  );
  for (const file of result.files.filter((f) => !f.endsWith('manifest.json')))
    expect(manifest.sha256[required(file.split('/').at(-1))]).toBe(
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    );
});
test.each(['User', 'none', null] as const)(
  'should export positive or complete coverage evidence and terminal unknown authors (%s)',
  async (author) => {
    const { store, dir } = setup();
    activity(store, author);
    await exportRun(store, dir);
    const row = required(rows(dir)[0]);
    expect(row.eligibility_status).toBe(
      author === 'User' ? 'pass' : author === 'none' ? 'fail' : 'unknown',
    );
    const rules = JSON.parse(required(row.eligibility_results_json));
    expect(rules[0].evidenceIds[0]).toMatch(
      author === 'none' ? /^page:/ : /^commit:1:sha$/,
    );
    const evidence = JSON.parse(required(row.evidence_json));
    expect(evidence.factsRevision).toBe(evidence.evaluationRevision);
    expect(evidence.coverage[0].refs[0].observedAt).toBe(
      '2026-10-06T12:00:00Z',
    );
    expect(json(dir, 'coverage.json').unknownReasons).toEqual(
      author === null ? { author_indeterminate: 1 } : {},
    );
    expect(json(dir, 'coverage.json').collection.required).toEqual({
      pending: 0,
      failed: 0,
      limited: 0,
      pendingEvaluations: 0,
    });
  },
);
test('should cover candidates, summaries, report and manifest with one snapshot during concurrent writes; stale pass re-evaluates as unknown without writes', async () => {
  const { store, dir, path } = setup();
  const f = store.readCandidateFacts(1);
  store.saveEvaluation(
    1,
    { status: 'pass', rules: [], requests: [] },
    f.revision,
  );
  const writer = openStore(path);
  stores.push(writer);
  await exportRun(store, dir, (done) => {
    if (done === 1) writer.beginInspection(1, '2026-10-06T12:00:00Z');
  });
  expect(required(rows(dir)[0]).eligibility_status).toBe('pass');
  expect(json(dir, 'coverage.json').byEligibility.pass).toBe(1);
  expect(
    json(dir, 'coverage.json').collection.required.pendingEvaluations,
  ).toBe(0);
  const before = required([...store.iterateCandidates()][0]);
  await exportRun(store, dir);
  expect(required(rows(dir)[0]).eligibility_status).toBe('unknown');
  expect(json(dir, 'coverage.json').byEligibility.unknown).toBe(1);
  expect(json(dir, 'coverage.json').unknownReasons).toEqual({
    activity_incomplete: 1,
    pending_evaluation: 1,
  });
  expect(
    json(dir, 'coverage.json').collection.required.pendingEvaluations,
  ).toBe(1);
  expect([...store.iterateCandidates()][0]).toEqual(before);
  expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('unknown: 1');
});
test('should not count cancelled old reasons as current unknown reasons; recorded limits and retry costs remain exact', async () => {
  const { store, dir } = setup();
  store.beginInspection(1, '2026-10-06T12:00:00Z');
  store.syncTasks(1, [
    {
      kind: 'commit_history',
      repositoryId: 1,
      since: '2025-01-01T00:00:00Z',
      until: '2026-10-06T12:00:00Z',
      branches: 'all',
    },
  ]);
  const task = required(store.readTasks()[0]);
  const inv = store.startInvocation(
    { ...DEFAULT_COLLECTION_LIMITS, maxActivityRequestsPerCandidate: 2 },
    'now',
  );
  for (const attempt of [1, 2]) {
    store.reserveActivityAttempt(task.id, inv, 2);
    store.saveAttempt(task.id, {
      attempt,
      startedAt: 10,
      finishedAt: 20,
      waitMs: 30,
      status: 200,
      responseBytes: null,
      rateLimitResource: 'core',
      rateLimitUsed: 500,
      error: null,
    });
  }
  store.recordCollectionDuration(task.id, inv, 100);
  store.saveCollectionStep(task, {
    repositoryObservations: [],
    refs: [],
    commits: [],
    response: null,
    checkpoint: null,
    state: 'limited',
    reason: 'request_budget',
  });
  store.syncTasks(1, []);
  await exportRun(store, dir);
  const c = json(dir, 'coverage.json').collection;
  expect(c.unknownReasons).not.toHaveProperty('request_budget');
  expect(c.required.limited).toBe(0);
  expect(c.activity).toMatchObject({
    attempts: 2,
    retries: 1,
    waitMs: 60,
    activeDurationMs: 100,
    responseBytes: null,
    rateLimitCost: null,
  });
  expect(c.invocations.at(-1).limits.maxActivityRequestsPerCandidate).toBe(2);
  const report = readFileSync(join(dir, 'report.md'), 'utf8');
  expect(report).toContain('mediana=100');
  expect(report).toContain('máximo=100');
  expect(report).toContain('espera=60');
  expect(report).toContain('deleted');
  expect(report).toContain('fork');
});

test('should replace a stale evaluation by decisive snapshot evidence without persistence', async () => {
  const { store, dir } = setup();
  activity(store, 'User');
  const candidate = required([...store.iterateCandidates()][0]);
  // Cancelling fulfilled work changes the revision while preserving positive evidence.
  store.syncTasks(1, []);
  await exportRun(store, dir);
  const row = required(rows(dir)[0]);
  expect(row.eligibility_status).toBe('pass');
  const e = JSON.parse(required(row.evidence_json));
  expect(e.evaluationSource).toBe('snapshot');
  expect(e.factsRevision).toBeGreaterThan(
    required(candidate.evaluationRevision),
  );
  expect(e.evaluationRevision).toBe(e.factsRevision);
  expect(required([...store.iterateCandidates()][0]).evaluationRevision).toBe(
    candidate.evaluationRevision,
  );
  expect(json(dir, 'coverage.json').unknownReasons).toEqual({});
});

test('should aggregate terminal authors and pending evaluations separately from task reasons', async () => {
  const { store, dir } = setup();
  activity(store, null);
  const sub = {
    id: 'q',
    queryId: 'q',
    strategy: 'terminology' as const,
    endpoint: 'repositories' as const,
    q: 'q',
    partitionLabel: '',
  };
  store.savePage(
    sub,
    2,
    page([hit(2)]),
    { subqueryId: 'q', nextPage: null, state: 'complete' },
    'later',
  );
  store.beginInspection(2, '2026-10-06T12:00:00Z');
  await exportRun(store, dir);
  const c = json(dir, 'coverage.json');
  expect(c.byEligibility.unknown).toBe(2);
  expect(c.unknownReasons).toEqual({
    author_indeterminate: 1,
    activity_incomplete: 1,
    pending_evaluation: 1,
  });
  expect(c.collection.unknownReasons).toEqual({});
  expect(c.collection.required.pendingEvaluations).toBe(1);
});
test('should release the snapshot after a failed CSV export for a subsequent report', async () => {
  const { store, dir } = setup();
  const bad = join(dir, 'bad');
  mkdirSync(join(bad, 'candidates.csv'), { recursive: true });
  await expect(exportRun(store, bad)).rejects.toThrow();
  store.beginInspection(1, '2026-10-06T12:00:00Z');
  await exportRun(store, dir);
  expect(
    JSON.parse(required(rows(dir)[0]).evidence_json ?? '{}').inspectionUntil,
  ).toBe('2026-10-06T12:00:00Z');
});
