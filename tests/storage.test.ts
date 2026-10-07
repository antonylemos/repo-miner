import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import type { CollectorStep } from '../src/discovery/collectors/types.js';
import {
  BudgetExhaustedError,
  DEFAULT_COLLECTION_LIMITS,
} from '../src/discovery/collectors/types.js';
import type {
  CommitFact,
  FactRequest,
} from '../src/discovery/eligibility/types.js';
import {
  type DiscoveryStore,
  openStore,
} from '../src/discovery/storage/store.js';
import { hit, page, query } from './helpers.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture');
  return value;
}
const dirs: string[] = [];
const stores: DiscoveryStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => {
    try {
      s.close();
    } catch {}
  });
  dirs.splice(0).forEach((d) => {
    rmSync(d, { recursive: true, force: true });
  });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-'));
  dirs.push(dir);
  const path = join(dir, 'run.db');
  const store = openStore(path);
  stores.push(store);
  const config = {
    catalog: { queries: [query({ id: 'q' })] },
    protocol: { eligibility: [] },
  };
  const sub = {
    id: 's',
    queryId: 'q',
    strategy: 'terminology' as const,
    endpoint: 'repositories' as const,
    q: 'q',
    partitionLabel: '',
  };
  const run = store.createRun({
    config,
    subqueries: [sub],
    startedAt: '2026-10-06T00:00:00Z',
    expansionDate: '2026-10-06',
    limits: DEFAULT_COLLECTION_LIMITS,
  });
  store.savePage(
    sub,
    1,
    page([hit(1), hit(2)]),
    { subqueryId: 's', nextPage: null, state: 'complete' },
    '2026-10-06T00:00:00Z',
  );
  return { store, path, config, run, sub };
}
const request = (repositoryId = 1): FactRequest => ({
  kind: 'commit_history',
  repositoryId,
  since: '2025-01-01',
  until: '2026-10-06T12:00:00Z',
  branches: 'all',
});
const commit = (repositoryId = 1): CommitFact => ({
  repositoryId,
  sha: 'a'.repeat(40),
  authoredDate: '2026-01-01',
  committedDate: '2026-01-01',
  author: { name: 'A', email: null, account: null },
  committer: { name: 'A', email: null, account: null },
  observedAt: '2026-10-06T12:00:00Z',
});
const step = (repositoryId = 1): CollectorStep => ({
  repositoryObservations: [],
  refs: [
    {
      name: 'main',
      headSha: 'a'.repeat(40),
      observedAt: '2026-10-06T12:00:00Z',
    },
  ],
  commits: [commit(repositoryId)],
  response: {
    requestUrl: 'https://api.github.com/repos/o/r/commits',
    observedAt: '2026-10-06T12:00:00Z',
    raw: [],
  },
  checkpoint: null,
  state: 'complete',
  reason: null,
});
test('should create a database without the enrichments table', () => {
  const { path } = setup();
  const db = new DatabaseSync(path, { readOnly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name);
  expect(tables).not.toContain('enrichments');
  expect(tables).toEqual(expect.arrayContaining(['runs', 'queries', 'hits']));
  db.close();
});
test('should roundtrip document and hash and keep the inspection upper bound immutable', () => {
  const { store, path, config, run } = setup();
  store.beginInspection(1, '2026-10-06T12:00:00Z');
  store.beginInspection(1, '2026-10-07T12:00:00Z');
  expect(store.readCandidateFacts(1).inspectionUntil).toBe(
    '2026-10-06T12:00:00Z',
  );
  store.close();
  const reopened = openStore(path);
  stores.push(reopened);
  expect(reopened.getStudyConfig()).toEqual(config);
  expect(reopened.getRun()).toEqual(run);
  expect(run.catalogHash).toHaveLength(64);
});
test('should isolate SHAs per repository, keep facts idempotent and reject obsolete evaluations', () => {
  const { store } = setup();
  for (const id of [1, 2]) {
    store.syncTasks(id, [request(id)]);
    const task = required(store.readTasks().find((t) => t.repositoryId === id));
    store.saveCollectionStep(task, step(id));
    const revision = store.readCandidateFacts(id).revision;
    store.saveCollectionStep(task, step(id));
    expect(store.readCandidateFacts(id).revision).toBe(revision);
    expect(store.readCandidateFacts(id).commits).toHaveLength(1);
  }
  const revision = store.readCandidateFacts(1).revision;
  expect(() =>
    store.saveEvaluation(
      1,
      { status: 'pass', rules: [], requests: [] },
      revision - 1,
    ),
  ).toThrow(/revision/);
  store.saveEvaluation(
    1,
    { status: 'pass', rules: [], requests: [] },
    revision,
  );
  expect([...store.iterateCandidates()][0]?.evaluation?.status).toBe('pass');
});
test('should reject reservation 21 across tasks and reset the budget per invocation', () => {
  const { store } = setup();
  store.syncTasks(1, [
    request(),
    { ...request(), branches: 'default' } as FactRequest,
  ]);
  const tasks = store.readTasks();
  const invocation = store.startInvocation(DEFAULT_COLLECTION_LIMITS, 'now');
  for (let n = 0; n < 20; n++)
    store.reserveActivityAttempt(required(tasks[n % 2]).id, invocation, 20);
  expect(() =>
    store.reserveActivityAttempt(required(tasks[0]).id, invocation, 20),
  ).toThrow(BudgetExhaustedError);
  const next = store.startInvocation(DEFAULT_COLLECTION_LIMITS, 'later');
  expect(() =>
    store.reserveActivityAttempt(required(tasks[0]).id, next, 20),
  ).not.toThrow();
  expect(store.readCollectionSummary().activity.attempts).toBe(21);
});
test('should roll back page checkpoints and choose the first REST observation deterministically', () => {
  const { store, sub } = setup();
  expect(() =>
    store.savePage(
      sub,
      2,
      page([hit(3)]),
      { subqueryId: 's', nextPage: 0, state: 'pending' },
      'later',
    ),
  ).toThrow();
  expect(store.readCoverage()[0]?.fetchedPages).toBe(1);
  store.savePage(
    sub,
    2,
    page([hit(1, { metadata: { pushed_at: 'new' } })]),
    { subqueryId: 's', nextPage: null, state: 'complete' },
    'later',
  );
  expect(store.readCandidateFacts(1).candidate.metadata.pushed_at).toBe(
    '2025-01-01T00:00:00Z',
  );
});
test('should isolate a WAL read snapshot from facts written by another connection', async () => {
  const { store, path } = setup();
  const writer = openStore(path);
  stores.push(writer);
  await store.withReadSnapshot(async (snapshot) => {
    const before = snapshot.readCandidateFacts(1).revision;
    writer.beginInspection(1, 'now');
    expect(snapshot.readCandidateFacts(1).revision).toBe(before);
  });
  expect(store.readCandidateFacts(1).inspectionUntil).toBe('now');
});
test('should leave an unknown or corrupt schema unchanged', () => {
  const { path } = setup();
  const unknown = `${path}.unknown`;
  const db = new DatabaseSync(unknown);
  db.exec('CREATE TABLE mystery (id INTEGER)');
  db.close();
  const bytes = readFileSync(unknown);
  expect(() => openStore(unknown)).toThrow();
  expect(readFileSync(unknown)).toEqual(bytes);
  const bad = `${path}.bad`;
  writeFileSync(bad, 'broken');
  expect(() => openStore(bad)).toThrow();
  expect(readFileSync(bad, 'utf8')).toBe('broken');
});

test('should keep ref membership and exact period coverage across a roundtrip', () => {
  const { store } = setup();
  store.syncTasks(1, [request()]);
  const task = required(store.readTasks()[0]);
  const result = step();
  result.refs.push({
    name: 'other',
    headSha: 'b'.repeat(40),
    observedAt: 'later',
  });
  required(result.commits[0]).refs = [required(result.refs[0])];
  store.saveCollectionStep(task, result);
  const facts = store.readCandidateFacts(1);
  expect(facts.commits[0]?.refs).toEqual([result.refs[0]]);
  expect(facts.coverage[0]?.request).toEqual(request());
  expect(facts.coverage[0]?.refs).toHaveLength(2);
  expect(facts.coverage[0]?.pages).toBe(1);
});
test('should count a metadata batch attempt once and persist activity retries and durations', () => {
  const { store } = setup();
  store.syncTasks(1, [request()]);
  const task = required(store.readTasks()[0]);
  const invocation = store.startInvocation(DEFAULT_COLLECTION_LIMITS, 'now');
  const event = {
    attempt: 1,
    startedAt: 100,
    finishedAt: 110,
    waitMs: 20,
    status: 500,
    responseBytes: 5,
    rateLimitResource: 'core',
    rateLimitUsed: 3,
    error: null,
  };
  store.reserveActivityAttempt(task.id, invocation, 20);
  store.saveAttempt(task.id, event);
  store.reserveActivityAttempt(task.id, invocation, 20);
  store.saveAttempt(task.id, { ...event, attempt: 2, status: 200 });
  store.recordCollectionDuration(task.id, invocation, 40);
  store.saveMetadataAttempt(invocation, [1, 2], event);
  const summary = store.readCollectionSummary();
  expect(summary.activity).toEqual({
    attempts: 2,
    retries: 1,
    responseBytes: 10,
    waitMs: 40,
    activeDurationMs: 40,
    rateLimitCost: null,
  });
  expect(summary.metadata.attempts).toBe(1);
  expect(summary.perCandidate).toHaveLength(1);
  expect(summary.required.pendingEvaluations).toBe(2);
});
test('should reject malformed schemas without mutation', () => {
  const { path } = setup();
  const unknown = `${path}.shape`;
  const db = new DatabaseSync(unknown);
  db.exec(
    'CREATE TABLE runs(id TEXT); CREATE TABLE candidates(repository_id INTEGER)',
  );
  db.close();
  const before = readFileSync(unknown);
  expect(() => openStore(unknown)).toThrow();
  expect(readFileSync(unknown)).toEqual(before);
});
test('should retain successful pages on task cancellation and fail obsolete task writes atomically', () => {
  const { store } = setup();
  store.syncTasks(1, [request()]);
  const task = required(store.readTasks()[0]);
  store.saveCollectionStep(task, step());
  store.syncTasks(1, []);
  expect(store.readTasks()[0]?.state).toBe('cancelled');
  expect(store.readCandidateFacts(1).commits).toHaveLength(1);
  store.syncTasks(1, [request()]);
  expect(store.readCandidateFacts(1).coverage[0]?.pages).toBe(1);
  const before = store.readCandidateFacts(1).revision;
  expect(() =>
    store.saveCollectionStep(task, { ...step(), commits: [commit(2)] }),
  ).toThrow(/repository/);
  expect(store.readCandidateFacts(1).revision).toBe(before);
});

test('should not change the inspection interval through a replacement collection task', () => {
  const { store } = setup();
  store.beginInspection(1, '2026-10-06T12:00:00Z');
  expect(() =>
    store.syncTasks(1, [
      { ...request(), until: '2026-10-07T12:00:00Z' } as FactRequest,
    ]),
  ).toThrow(/upper bound/);
  expect(store.readTasks()).toHaveLength(0);
});

test('should keep an interrupted reservation unknown after a crash resume and attribute completion to the new invocation', () => {
  const { store, path } = setup();
  store.syncTasks(1, [request()]);
  const task = required(store.readTasks()[0]);
  const a = store.startInvocation(DEFAULT_COLLECTION_LIMITS, 'first');
  store.reserveActivityAttempt(task.id, a, 20);
  store.close();
  const resumed = openStore(path);
  stores.push(resumed);
  const b = resumed.startInvocation(DEFAULT_COLLECTION_LIMITS, 'resumed');
  resumed.reserveActivityAttempt(task.id, b, 20);
  resumed.saveAttempt(task.id, {
    attempt: 2,
    startedAt: 100,
    finishedAt: 110,
    waitMs: 15,
    status: 200,
    responseBytes: 42,
    rateLimitResource: 'core',
    rateLimitUsed: 7,
    error: null,
  });
  const summary = resumed.readCollectionSummary();
  const first = required(summary.invocations.find((i) => i.id === a));
  const second = required(summary.invocations.find((i) => i.id === b));
  expect(first.activity).toMatchObject({
    attempts: 1,
    retries: 0,
    responseBytes: null,
    waitMs: 0,
  });
  expect(second.activity).toMatchObject({
    attempts: 1,
    retries: 1,
    responseBytes: 42,
    waitMs: 15,
  });
  expect(() =>
    resumed.saveAttempt(task.id, {
      attempt: 1,
      startedAt: 1,
      finishedAt: 2,
      waitMs: 0,
      status: 200,
      responseBytes: 1,
      rateLimitResource: null,
      rateLimitUsed: null,
      error: null,
    }),
  ).toThrow(/reserved/);
});
test('should not initialize a run on a tableless existing database', () => {
  const { path } = setup();
  const tableless = `${path}.tableless`;
  new DatabaseSync(tableless).close();
  const bytes = readFileSync(tableless);
  expect(() => openStore(tableless)).toThrow(/incompatible format/);
  expect(readFileSync(tableless)).toEqual(bytes);
});
