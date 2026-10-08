import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hit, page, query } from '@tests/helpers.js';
import { afterEach, expect, it } from 'vitest';
import { BudgetExhaustedError } from '@/modules/discovery/collection/budget.js';
import { DEFAULT_COLLECTION_LIMITS } from '@/modules/discovery/collection/limits.js';
import type { CollectorStep } from '@/modules/discovery/model/collection.js';
import type {
  CommitFact,
  FactRequest,
} from '@/modules/discovery/model/facts.js';
import type { DiscoveryStore } from '@/modules/discovery/model/store.js';
import { inspectStore, openStore } from '@/modules/discovery/storage/store.js';

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
it('should create a database without the enrichments table', () => {
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
it('should roundtrip document and hash and keep the inspection upper bound immutable', () => {
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
it('should isolate SHAs per repository, keep facts idempotent and reject obsolete evaluations', () => {
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
it('should reject reservation 21 across tasks and reset the budget per invocation', () => {
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
it('should roll back page checkpoints and choose the first REST observation deterministically', () => {
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
it('should isolate a WAL read snapshot from facts written by another connection', async () => {
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
it('should leave an unknown or corrupt schema unchanged', () => {
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

it('should keep ref membership and exact period coverage across a roundtrip', () => {
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
it('should count a metadata batch attempt once and persist activity retries and durations', () => {
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
it('should reject malformed schemas without mutation', () => {
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
it('should retain successful pages on task cancellation and fail obsolete task writes atomically', () => {
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

it('should not change the inspection interval through a replacement collection task', () => {
  const { store } = setup();
  store.beginInspection(1, '2026-10-06T12:00:00Z');
  expect(() =>
    store.syncTasks(1, [
      { ...request(), until: '2026-10-07T12:00:00Z' } as FactRequest,
    ]),
  ).toThrow(/upper bound/);
  expect(store.readTasks()).toHaveLength(0);
});

it('should keep an interrupted reservation unknown after a crash resume and attribute completion to the new invocation', () => {
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
it('should not initialize a run on a tableless existing database', () => {
  const { path } = setup();
  const tableless = `${path}.tableless`;
  new DatabaseSync(tableless).close();
  const bytes = readFileSync(tableless);
  expect(() => openStore(tableless)).toThrow(/incompatible format/);
  expect(readFileSync(tableless)).toEqual(bytes);
});
it('should summarize attempts, retries, durations and interrupted reservations per invocation', () => {
  const { store } = setup();
  store.syncTasks(1, [request(1)]);
  store.syncTasks(2, [request(2)]);
  const [first, second] = store.readTasks();
  const firstTask = required(first);
  const secondTask = required(second);
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
  const invocationA = store.startInvocation(DEFAULT_COLLECTION_LIMITS, 'a');
  store.reserveActivityAttempt(firstTask.id, invocationA, 20);
  store.saveAttempt(firstTask.id, event);
  store.reserveActivityAttempt(firstTask.id, invocationA, 20);
  store.saveAttempt(firstTask.id, {
    ...event,
    attempt: 2,
    status: 200,
    waitMs: 5,
    responseBytes: 7,
  });
  store.recordCollectionDuration(firstTask.id, invocationA, 40);
  store.reserveActivityAttempt(secondTask.id, invocationA, 20);
  store.saveMetadataAttempt(invocationA, [1, 2], {
    ...event,
    startedAt: 200,
    finishedAt: 230,
    waitMs: 4,
    responseBytes: 9,
  });
  const invocationB = store.startInvocation(DEFAULT_COLLECTION_LIMITS, 'b');
  store.reserveActivityAttempt(firstTask.id, invocationB, 20);
  store.saveAttempt(firstTask.id, {
    ...event,
    waitMs: 3,
    responseBytes: null,
  });
  store.recordCollectionDuration(firstTask.id, invocationB, 25);
  store.saveMetadataAttempt(invocationB, [1], {
    ...event,
    startedAt: 10,
    finishedAt: 15,
    waitMs: 0,
    responseBytes: null,
  });
  store.saveCollectionStep(firstTask, step(1));

  const summary = store.readCollectionSummary();
  const metrics = (
    attempts: number,
    retries: number,
    responseBytes: number | null,
    waitMs: number,
    activeDurationMs: number,
  ) => ({
    attempts,
    retries,
    responseBytes,
    waitMs,
    activeDurationMs,
    rateLimitCost: null,
  });
  expect(summary.activity).toEqual(metrics(4, 1, null, 28, 65));
  expect(summary.metadata).toEqual(metrics(2, 0, null, 4, 39));
  expect(summary.required).toEqual({
    pending: 1,
    failed: 0,
    limited: 0,
    pendingEvaluations: 2,
  });
  expect(summary.unknownReasons).toEqual({});
  expect(
    summary.perCandidate.map(
      ({ repositoryId, invocationId, activity, ...examined }) => ({
        repositoryId,
        invocationId,
        activity,
        ...examined,
      }),
    ),
  ).toEqual([
    {
      repositoryId: 1,
      invocationId: invocationA,
      activity: metrics(2, 1, 12, 25, 40),
      commitsExamined: 0,
      refsExamined: 0,
    },
    {
      repositoryId: 2,
      invocationId: invocationA,
      activity: metrics(1, 0, null, 0, 0),
      commitsExamined: 0,
      refsExamined: 0,
    },
    {
      repositoryId: 1,
      invocationId: invocationB,
      activity: metrics(1, 0, null, 3, 25),
      commitsExamined: 1,
      refsExamined: 1,
    },
  ]);
  expect(
    summary.invocations.map(({ id, activity, metadata }) => ({
      id,
      activity,
      metadata,
    })),
  ).toEqual([
    {
      id: expect.any(String),
      activity: metrics(0, 0, null, 0, 0),
      metadata: metrics(0, 0, null, 0, 0),
    },
    {
      id: invocationA,
      activity: metrics(3, 1, null, 25, 40),
      metadata: metrics(1, 0, 9, 4, 34),
    },
    {
      id: invocationB,
      activity: metrics(1, 0, null, 3, 25),
      metadata: metrics(1, 0, null, 0, 5),
    },
  ]);
});
it('should reject a snapshot opened inside another snapshot and release the outer one', async () => {
  const { store } = setup();

  await expect(
    store.withReadSnapshot((outer) => outer.withReadSnapshot(async () => 1)),
  ).rejects.toThrow('Nested snapshots are unsupported');
  await expect(store.withReadSnapshot(async () => 2)).resolves.toBe(2);
});
it('should list candidates without a current evaluation as dirty', () => {
  const { store } = setup();
  const ids = () => store.readDirtyCandidates().map((c) => c.id);
  expect(store.readDirtyCandidates()).toEqual([
    { id: 1, nodeId: 'R_1' },
    { id: 2, nodeId: 'R_2' },
  ]);

  const evaluation = {
    status: 'not_applied' as const,
    rules: [],
    requests: [],
  };
  store.saveEvaluation(1, evaluation, store.readCandidateFacts(1).revision);
  expect(ids()).toEqual([2]);

  store.beginInspection(1, '2026-10-06T12:00:00Z');
  expect(ids()).toEqual([1, 2]);

  store.saveEvaluation(1, evaluation, store.readCandidateFacts(1).revision);
  store.saveEvaluation(2, evaluation, store.readCandidateFacts(2).revision);
  expect(ids()).toEqual([]);
});
it('should mark a candidate dirty again after a new observation or page', () => {
  const { store, sub } = setup();
  const evaluation = {
    status: 'not_applied' as const,
    rules: [],
    requests: [],
  };
  for (const id of [1, 2])
    store.saveEvaluation(id, evaluation, store.readCandidateFacts(id).revision);
  expect(store.readDirtyCandidates()).toEqual([]);

  store.savePage(
    sub,
    2,
    page([hit(2, { metadata: { pushed_at: '2026-02-02T00:00:00Z' } })]),
    { subqueryId: 's', nextPage: null, state: 'complete' },
    '2026-10-06T01:00:00Z',
  );
  expect(store.readDirtyCandidates().map((c) => c.id)).toEqual([2]);
});
it('should read completed task requests grouped by repository', () => {
  const { store } = setup();
  for (const id of [1, 2]) store.syncTasks(id, [request(id)]);
  expect(store.readCompletedRequests().size).toBe(0);

  const task = required(store.readTasks().find((t) => t.repositoryId === 2));
  store.saveCollectionStep(task, step(2));
  expect([...store.readCompletedRequests()]).toEqual([[2, [request(2)]]]);
});
it('should count tasks by kind and state like the materialized tasks', () => {
  const { store } = setup();
  const metadata = (id: number): FactRequest => ({
    kind: 'repository_metadata',
    repositoryId: id,
    nodeId: `R_${id}`,
  });
  store.syncTasks(1, [request(1), metadata(1)]);
  store.syncTasks(2, [request(2), metadata(2)]);
  store.saveCollectionStep(
    required(
      store
        .readTasks()
        .find(
          (t) => t.repositoryId === 1 && t.request.kind === 'commit_history',
        ),
    ),
    step(1),
  );
  store.syncTasks(2, [metadata(2)]);

  const expected = new Map<string, number>();
  for (const task of store.readTasks()) {
    const key = `${task.request.kind}:${task.state}`;
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }
  const actual = new Map(
    store.countTasks().map((c) => [`${c.kind}:${c.state}`, c.count]),
  );
  expect(actual).toEqual(expected);
  expect(actual.get('commit_history:cancelled')).toBe(1);
});
it('should bump the facts revision on every change that alters evaluated facts', () => {
  const { store, run } = setup();
  const invocationId = required(run.invocations[0]).id;
  const revision = () => store.readCandidateFacts(1).revision;
  const bumped = (change: () => void) => {
    const before = revision();
    change();
    expect(revision()).toBeGreaterThan(before);
  };
  const unchanged = (change: () => void) => {
    const before = revision();
    change();
    expect(revision()).toBe(before);
  };

  bumped(() => store.beginInspection(1, '2026-10-06T12:00:00Z'));
  bumped(() => store.syncTasks(1, [request(1)]));
  unchanged(() => store.syncTasks(1, [request(1)]));
  const task = required(store.readTasks().find((t) => t.repositoryId === 1));
  bumped(() => store.saveCollectionStep(task, step(1)));
  unchanged(() => store.saveCollectionStep(task, step(1)));
  bumped(() => store.syncTasks(1, []));
  bumped(() => store.syncTasks(1, [request(1)]));
  expect(
    required(store.readTasks().find((t) => t.repositoryId === 1)).state,
  ).toBe('pending');
  unchanged(() => {
    store.reserveActivityAttempt(task.id, invocationId, 20);
    store.recordCollectionDuration(task.id, invocationId, 5);
  });
});
it('should keep the collection summary stable for a mixed multi-invocation round', () => {
  const { store } = setup();
  store.syncTasks(1, [request(1)]);
  store.syncTasks(2, [request(2)]);
  const [first, second] = store.readTasks();
  const firstTask = required(first);
  const secondTask = required(second);
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
  const invocationA = store.startInvocation(DEFAULT_COLLECTION_LIMITS, 'a');
  store.reserveActivityAttempt(firstTask.id, invocationA, 20);
  store.saveAttempt(firstTask.id, event);
  store.reserveActivityAttempt(firstTask.id, invocationA, 20);
  store.saveAttempt(firstTask.id, { ...event, attempt: 2, responseBytes: 7 });
  store.recordCollectionDuration(firstTask.id, invocationA, 40);
  // Interrupted reservation: no event, so bytes are unknown for the group.
  store.reserveActivityAttempt(secondTask.id, invocationA, 20);
  const invocationB = store.startInvocation(DEFAULT_COLLECTION_LIMITS, 'b');
  store.reserveActivityAttempt(firstTask.id, invocationB, 20);
  store.saveAttempt(firstTask.id, { ...event, responseBytes: null });
  store.recordCollectionDuration(firstTask.id, invocationB, 25);
  // Candidate with a duration but no attempt in this invocation.
  store.recordCollectionDuration(secondTask.id, invocationB, 9);
  store.saveMetadataAttempt(invocationB, [1, 2], event);
  store.saveCollectionStep(firstTask, step(1));
  store.syncTasks(2, []);

  const labels = new Map(
    store
      .readCollectionSummary()
      .invocations.map((inv, index) => [inv.id, `invocation-${index}`]),
  );
  const stable = JSON.parse(
    JSON.stringify(store.readCollectionSummary()).replace(
      /[0-9a-f]{8}-[0-9a-f-]{27}/g,
      (id) => labels.get(id) ?? id,
    ),
  );
  expect(stable).toMatchInlineSnapshot(`
    {
      "activity": {
        "activeDurationMs": 74,
        "attempts": 4,
        "rateLimitCost": null,
        "responseBytes": null,
        "retries": 1,
        "waitMs": 60,
      },
      "invocations": [
        {
          "activity": {
            "activeDurationMs": 0,
            "attempts": 0,
            "rateLimitCost": null,
            "responseBytes": null,
            "retries": 0,
            "waitMs": 0,
          },
          "id": "invocation-0",
          "limits": {
            "branchesPerPage": 100,
            "commitsPerPage": 30,
            "maxActivityDurationMs": null,
            "maxActivityRequestsPerCandidate": 20,
          },
          "metadata": {
            "activeDurationMs": 0,
            "attempts": 0,
            "rateLimitCost": null,
            "responseBytes": null,
            "retries": 0,
            "waitMs": 0,
          },
        },
        {
          "activity": {
            "activeDurationMs": 40,
            "attempts": 3,
            "rateLimitCost": null,
            "responseBytes": null,
            "retries": 1,
            "waitMs": 40,
          },
          "id": "invocation-1",
          "limits": {
            "branchesPerPage": 100,
            "commitsPerPage": 30,
            "maxActivityDurationMs": null,
            "maxActivityRequestsPerCandidate": 20,
          },
          "metadata": {
            "activeDurationMs": 0,
            "attempts": 0,
            "rateLimitCost": null,
            "responseBytes": null,
            "retries": 0,
            "waitMs": 0,
          },
        },
        {
          "activity": {
            "activeDurationMs": 34,
            "attempts": 1,
            "rateLimitCost": null,
            "responseBytes": null,
            "retries": 0,
            "waitMs": 20,
          },
          "id": "invocation-2",
          "limits": {
            "branchesPerPage": 100,
            "commitsPerPage": 30,
            "maxActivityDurationMs": null,
            "maxActivityRequestsPerCandidate": 20,
          },
          "metadata": {
            "activeDurationMs": 30,
            "attempts": 1,
            "rateLimitCost": null,
            "responseBytes": 5,
            "retries": 0,
            "waitMs": 20,
          },
        },
      ],
      "metadata": {
        "activeDurationMs": 30,
        "attempts": 1,
        "rateLimitCost": null,
        "responseBytes": 5,
        "retries": 0,
        "waitMs": 20,
      },
      "perCandidate": [
        {
          "activity": {
            "activeDurationMs": 40,
            "attempts": 2,
            "rateLimitCost": null,
            "responseBytes": 12,
            "retries": 1,
            "waitMs": 40,
          },
          "commitsExamined": 0,
          "invocationId": "invocation-1",
          "refsExamined": 0,
          "repositoryId": 1,
        },
        {
          "activity": {
            "activeDurationMs": 0,
            "attempts": 1,
            "rateLimitCost": null,
            "responseBytes": null,
            "retries": 0,
            "waitMs": 0,
          },
          "commitsExamined": 0,
          "invocationId": "invocation-1",
          "refsExamined": 0,
          "repositoryId": 2,
        },
        {
          "activity": {
            "activeDurationMs": 25,
            "attempts": 1,
            "rateLimitCost": null,
            "responseBytes": null,
            "retries": 0,
            "waitMs": 20,
          },
          "commitsExamined": 1,
          "invocationId": "invocation-2",
          "refsExamined": 1,
          "repositoryId": 1,
        },
        {
          "activity": {
            "activeDurationMs": 9,
            "attempts": 0,
            "rateLimitCost": null,
            "responseBytes": null,
            "retries": 0,
            "waitMs": 0,
          },
          "commitsExamined": 0,
          "invocationId": "invocation-2",
          "refsExamined": 0,
          "repositoryId": 2,
        },
      ],
      "required": {
        "failed": 0,
        "limited": 0,
        "pending": 0,
        "pendingEvaluations": 2,
      },
      "unknownReasons": {},
    }
  `);
});
it('should read the active duration of a candidate in one invocation like the summary does', () => {
  const { store } = setup();
  store.syncTasks(1, [request(1)]);
  store.syncTasks(2, [request(2)]);
  const firstTask = required(
    store.readTasks().find((t) => t.repositoryId === 1),
  );
  const invocationA = store.startInvocation(DEFAULT_COLLECTION_LIMITS, 'a');
  const invocationB = store.startInvocation(DEFAULT_COLLECTION_LIMITS, 'b');
  store.recordCollectionDuration(firstTask.id, invocationA, 40);
  store.recordCollectionDuration(firstTask.id, invocationA, 2);
  store.recordCollectionDuration(firstTask.id, invocationB, 25);
  // A cancelled task of the same repository still contributes its duration.
  store.syncTasks(1, []);
  store.recordCollectionDuration(firstTask.id, invocationA, 3);

  expect(store.readActiveDuration(1, invocationA)).toBe(45);
  expect(store.readActiveDuration(1, invocationB)).toBe(25);
  expect(store.readActiveDuration(2, invocationA)).toBe(0);
  for (const candidate of store.readCollectionSummary().perCandidate)
    expect(
      store.readActiveDuration(candidate.repositoryId, candidate.invocationId),
    ).toBe(candidate.activity.activeDurationMs);
});
it('should add the per-candidate indexes to an existing database and keep its data', () => {
  const { store, path } = setup();
  store.syncTasks(1, [request(1)]);
  const task = required(store.readTasks()[0]);
  store.saveCollectionStep(task, step(1));
  const before = store.readCandidateFacts(1);
  store.close();
  const indexes = [
    'repository_observations_repository',
    'collection_pages_task',
    'collection_tasks_repository',
    'collection_attempts_repository',
  ];
  const listIndexes = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name);
    db.close();
    return names;
  };
  const db = new DatabaseSync(path);
  for (const name of indexes) db.exec(`DROP INDEX ${name}`);
  db.close();
  expect(listIndexes()).not.toEqual(expect.arrayContaining(indexes));

  expect(() => inspectStore(path)).not.toThrow();
  const reopened = openStore(path);
  stores.push(reopened);

  expect(listIndexes()).toEqual(expect.arrayContaining(indexes));
  expect(reopened.readCandidateFacts(1)).toEqual(before);
});
