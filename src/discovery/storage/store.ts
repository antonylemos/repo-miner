import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, catalogHash } from '../catalog.js';
import {
  BudgetExhaustedError,
  type CollectionLimits,
  type CollectionSummary,
  type CollectionTask,
  type CollectorStep,
  type RequestMetrics,
} from '../collectors/types.js';
import { EVALUATOR_VERSIONS } from '../eligibility/evaluate.js';
import type {
  ActivityCoverage,
  CandidateFacts,
  CommitFact,
  FactRequest,
  ProtocolEvaluation,
  RefObservation,
  RepositoryObservation,
  StudyConfig,
} from '../eligibility/types.js';
import type { HttpAttemptEvent } from '../http.js';
import { parseStudyConfig } from '../study-config.js';
import type { Candidate, StoredHit, Subquery } from '../types.js';
import {
  inspectDatabase,
  openConnection,
  type Row,
  SEARCH_SCHEMA,
  transaction,
} from './connection.js';
import { createSearchData, type SearchStore } from './search-data.js';
export type Run = {
  id: string;
  catalog: StudyConfig['catalog'];
  protocol: StudyConfig['protocol'];
  catalogHash: string;
  protocolHash: string;
  evaluatorVersions: Record<string, number>;
  startedAt: string;
  expansionDate: string;
  endedAt: string | null;
  state: 'running' | 'complete' | 'partial';
  invocations: Array<{
    id: string;
    limits: CollectionLimits;
    startedAt: string;
  }>;
};
export type StoredCandidate = Candidate & {
  firstSeenAt: string;
  metadataObservedAt: string | null;
  evaluation: ProtocolEvaluation | null;
  factsRevision: number;
  evaluationRevision: number | null;
};
export interface DiscoveryStore extends SearchStore {
  createRun(input: {
    config: StudyConfig;
    subqueries: Subquery[];
    startedAt: string;
    expansionDate: string;
    limits: CollectionLimits;
  }): Run;
  getRun(): Run;
  getStudyConfig(): StudyConfig;
  iterateCandidates(): Iterable<StoredCandidate>;
  readHits(): StoredHit[];
  readCandidateFacts(repositoryId: number): CandidateFacts;
  beginInspection(repositoryId: number, until: string): void;
  syncTasks(repositoryId: number, requests: FactRequest[]): void;
  readTasks(): CollectionTask[];
  saveCollectionStep(task: CollectionTask, result: CollectorStep): void;
  reserveActivityAttempt(
    taskId: string,
    invocationId: string,
    limit: number,
  ): void;
  saveAttempt(taskId: string, event: HttpAttemptEvent): void;
  saveMetadataAttempt(
    invocationId: string,
    repositoryIds: number[],
    event: HttpAttemptEvent,
  ): void;
  recordCollectionDuration(
    taskId: string,
    invocationId: string,
    durationMs: number,
  ): void;
  saveEvaluation(
    repositoryId: number,
    evaluation: ProtocolEvaluation,
    factsRevision: number,
  ): void;
  readCollectionSummary(): CollectionSummary;
  startInvocation(limits: CollectionLimits, now: string): string;
  finish(input: { state: 'complete' | 'partial'; endedAt: string }): void;
  withReadSnapshot<T>(work: (store: DiscoveryStore) => Promise<T>): Promise<T>;
  close(): void;
}
const SCHEMA =
  `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, config_json TEXT NOT NULL, catalog_hash TEXT NOT NULL, protocol_hash TEXT NOT NULL, versions_json TEXT NOT NULL, started_at TEXT NOT NULL, expansion_date TEXT NOT NULL, ended_at TEXT, state TEXT NOT NULL);
` +
  SEARCH_SCHEMA.replace(
    'first_seen_at TEXT NOT NULL',
    'first_seen_at TEXT NOT NULL, facts_revision INTEGER NOT NULL DEFAULT 0',
  ) +
  `
CREATE TABLE IF NOT EXISTS repository_observations (id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES candidates(repository_id), data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inspections (repository_id INTEGER PRIMARY KEY REFERENCES candidates(repository_id), until TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity_refs (repository_id INTEGER NOT NULL REFERENCES candidates(repository_id), id TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(repository_id,id));
CREATE TABLE IF NOT EXISTS activity_commits (repository_id INTEGER NOT NULL REFERENCES candidates(repository_id), sha TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(repository_id,sha));
CREATE TABLE IF NOT EXISTS collection_tasks (id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES candidates(repository_id), request_json TEXT NOT NULL, state TEXT NOT NULL, checkpoint_json TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS activity_commit_refs (repository_id INTEGER NOT NULL, ref_id TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY(repository_id,ref_id,sha), FOREIGN KEY(repository_id,ref_id) REFERENCES activity_refs(repository_id,id), FOREIGN KEY(repository_id,sha) REFERENCES activity_commits(repository_id,sha));
CREATE TABLE IF NOT EXISTS collection_pages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES collection_tasks(id), data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invocations (id TEXT PRIMARY KEY, limits_json TEXT NOT NULL, started_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_attempts (id INTEGER PRIMARY KEY, task_id TEXT REFERENCES collection_tasks(id), repository_id INTEGER REFERENCES candidates(repository_id), invocation_id TEXT NOT NULL REFERENCES invocations(id), kind TEXT NOT NULL, targets_json TEXT, event_json TEXT);
CREATE TABLE IF NOT EXISTS collection_durations (task_id TEXT NOT NULL REFERENCES collection_tasks(id), invocation_id TEXT NOT NULL REFERENCES invocations(id), duration_ms REAL NOT NULL);
CREATE TABLE IF NOT EXISTS evaluations (repository_id INTEGER PRIMARY KEY REFERENCES candidates(repository_id), facts_revision INTEGER NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_fact_invocations (repository_id INTEGER NOT NULL REFERENCES candidates(repository_id), invocation_id TEXT NOT NULL REFERENCES invocations(id), kind TEXT NOT NULL, fact_id TEXT NOT NULL, PRIMARY KEY(repository_id,invocation_id,kind,fact_id));
CREATE TABLE IF NOT EXISTS task_refs (task_id TEXT NOT NULL REFERENCES collection_tasks(id), repository_id INTEGER NOT NULL, ref_id TEXT NOT NULL, PRIMARY KEY(task_id,repository_id,ref_id), FOREIGN KEY(repository_id,ref_id) REFERENCES activity_refs(repository_id,id));
`;
const hash = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
function validateLimits(limits: CollectionLimits): void {
  for (const key of [
    'branchesPerPage',
    'commitsPerPage',
    'maxActivityRequestsPerCandidate',
  ] as const)
    if (!Number.isInteger(limits[key]) || limits[key] <= 0)
      throw new Error('Collection limits must be positive integers');
  if (
    limits.branchesPerPage > 100 ||
    limits.commitsPerPage > 100 ||
    (limits.maxActivityDurationMs !== null &&
      (!Number.isFinite(limits.maxActivityDurationMs) ||
        limits.maxActivityDurationMs <= 0))
  )
    throw new Error('Invalid collection limits');
}
/** Validates an existing run database without opening it for writing. */
export function inspectStore(path: string): void {
  inspectDatabase(path, SCHEMA);
}
export function openStore(path: string): DiscoveryStore {
  const db = openConnection(path, SCHEMA);
  const tx = (work: () => void) => transaction(db, work);
  const get = (sql: string, ...values: Array<string | number | null>) =>
    db.prepare(sql).get(...values) as Row | undefined;
  const all = (sql: string, ...values: Array<string | number | null>) =>
    db.prepare(sql).all(...values) as Row[];
  const run = (sql: string, ...values: Array<string | number | null>) =>
    db.prepare(sql).run(...values);
  const bump = (id: number) => {
    run(
      'UPDATE candidates SET facts_revision = facts_revision + 1 WHERE repository_id = ?',
      id,
    );
  };
  const candidateRow = (id: number): Row => {
    const row = get('SELECT * FROM candidates WHERE repository_id = ?', id);
    if (!row) throw new Error(`Unknown repository ${id}`);
    return row;
  };
  const observation = (fact: RepositoryObservation): boolean =>
    Number(
      run(
        'INSERT OR IGNORE INTO repository_observations VALUES (?, ?, ?)',
        fact.id,
        fact.repositoryId,
        canonicalJson(fact),
      ).changes,
    ) > 0;
  const search = createSearchData(db, tx);
  const runRow = (): Row => {
    const row = get('SELECT * FROM runs LIMIT 1');
    if (!row) throw new Error('No protocol run has been created');
    return row;
  };
  const taskFromRow = (row: Row): CollectionTask => ({
    id: String(row.id),
    repositoryId: Number(row.repository_id),
    request: parse(row.request_json),
    state: row.state as CollectionTask['state'],
    checkpoint:
      row.checkpoint_json === null ? null : parse(row.checkpoint_json),
    reason: row.reason === null ? null : String(row.reason),
  });
  const taskRow = (id: string): Row => {
    const row = get('SELECT * FROM collection_tasks WHERE id = ?', id);
    if (!row) throw new Error('Unknown collection task');
    return row;
  };
  function* candidates(repositoryId?: number): Generator<StoredCandidate> {
    for (const row of repositoryId === undefined
      ? all('SELECT * FROM candidates ORDER BY repository_id')
      : all('SELECT * FROM candidates WHERE repository_id=?', repositoryId)) {
      const id = Number(row.repository_id);
      const firstRest = get(
        `SELECT h.* FROM hits h JOIN queries q ON q.query_id=h.query_id WHERE h.repository_id=? AND q.endpoint='repositories' ORDER BY h.fetched_at,h.subquery_id,h.path LIMIT 1`,
        id,
      );
      const e = get('SELECT * FROM evaluations WHERE repository_id=?', id);
      yield {
        id,
        nodeId: String(row.node_id),
        fullName: String(firstRest?.full_name ?? row.full_name),
        url: String(firstRest?.repository_url ?? row.url),
        metadata: parse(firstRest?.metadata_json ?? row.metadata_json),
        firstSeenAt: String(row.first_seen_at),
        metadataObservedAt: String(firstRest?.fetched_at ?? row.first_seen_at),
        factsRevision: Number(row.facts_revision),
        evaluation: e ? parse(e.data_json) : null,
        evaluationRevision: e ? Number(e.facts_revision) : null,
      };
    }
  }
  // Only this connection's current transport attempt may complete its reservation.
  // Interrupted reservations remain persisted with unknown telemetry after resume.
  const ownedReservations = new Map<string, number>();
  let snapshot = false;
  const store: DiscoveryStore = {
    ...search,
    createRun(input) {
      const config = parseStudyConfig(
        input.config.catalog,
        input.config.protocol,
      );
      validateLimits(input.limits);
      if (get('SELECT id FROM runs LIMIT 1'))
        throw new Error('This database already contains a protocol run');
      const id = randomUUID();
      tx(() => {
        run(
          'INSERT INTO runs VALUES (?,?,?,?,?,?,?,NULL,?)',
          id,
          canonicalJson(config),
          catalogHash(config.catalog),
          hash(config.protocol),
          canonicalJson(EVALUATOR_VERSIONS),
          input.startedAt,
          input.expansionDate,
          'running',
        );
        config.catalog.queries.forEach((q, i) => {
          run(
            'INSERT INTO queries VALUES (?,?,?,?,?,?,?)',
            q.id,
            i,
            q.strategy,
            q.endpoint,
            q.q,
            q.rationale,
            q.partition ? JSON.stringify(q.partition) : null,
          );
        });
        input.subqueries.forEach((s, i) => {
          run(
            'INSERT INTO subqueries VALUES (?,?,?,?,?)',
            s.id,
            s.queryId,
            i,
            s.q,
            s.partitionLabel,
          );
          run('INSERT INTO checkpoints VALUES (?,1,?,NULL)', s.id, 'pending');
        });
        run(
          'INSERT INTO invocations VALUES (?,?,?)',
          randomUUID(),
          canonicalJson(input.limits),
          input.startedAt,
        );
      });
      return store.getRun();
    },
    getRun() {
      const r = runRow();
      const config = parse<StudyConfig>(r.config_json);
      return {
        id: String(r.id),
        catalog: config.catalog,
        protocol: config.protocol,
        catalogHash: String(r.catalog_hash),
        protocolHash: String(r.protocol_hash),
        evaluatorVersions: parse(r.versions_json),
        startedAt: String(r.started_at),
        expansionDate: String(r.expansion_date),
        endedAt: r.ended_at === null ? null : String(r.ended_at),
        state: r.state as Run['state'],
        invocations: all('SELECT * FROM invocations ORDER BY rowid').map(
          (i) => ({
            id: String(i.id),
            limits: parse(i.limits_json),
            startedAt: String(i.started_at),
          }),
        ),
      };
    },
    getStudyConfig() {
      return parse(runRow().config_json);
    },
    iterateCandidates: candidates,
    savePage(subquery, page, result, checkpoint, fetchedAt) {
      // Shared writer transaction encloses search facts and provenance/revision writes.
      const writer = createSearchData(db, (work) =>
        tx(() => {
          const existed = get(
            'SELECT 1 FROM pages WHERE subquery_id=? AND page=?',
            subquery.id,
            page,
          );
          work();
          if (existed) return;
          const changed = new Set<number>();
          for (const hit of result.hits) {
            const id = hit.candidate.id;
            const o: RepositoryObservation = {
              id: `search:${subquery.id}:${page}:${id}:${hash(hit.path)}`,
              repositoryId: id,
              source: 'search',
              observedAt: fetchedAt,
              status: 'ok',
              data: hit.candidate.metadata,
            };
            if (observation(o)) changed.add(id);
          }
          changed.forEach(bump);
        }),
      );
      writer.savePage(subquery, page, result, checkpoint, fetchedAt);
    },
    readCandidateFacts(id) {
      const row = candidateRow(id);
      const candidate = candidates(id).next().value;
      if (!candidate) throw new Error(`Unknown repository ${id}`);
      const observations = all(
        'SELECT data_json FROM repository_observations WHERE repository_id=? ORDER BY rowid',
        id,
      ).map((r) => parse<RepositoryObservation>(r.data_json));
      const commits = all(
        'SELECT * FROM activity_commits WHERE repository_id=? ORDER BY sha',
        id,
      ).map((r) => ({
        ...parse<CommitFact>(r.data_json),
        refs: all(
          'SELECT r.data_json FROM activity_refs r JOIN activity_commit_refs c ON c.repository_id=r.repository_id AND c.ref_id=r.id WHERE c.repository_id=? AND c.sha=? ORDER BY r.id',
          id,
          String(r.sha),
        ).map((r) => parse<RefObservation>(r.data_json)),
      }));
      const coverage: ActivityCoverage[] = all(
        "SELECT * FROM collection_tasks WHERE repository_id=? AND state!='cancelled' ORDER BY id",
        id,
      )
        .map(taskFromRow)
        .filter(
          (
            t,
          ): t is CollectionTask & {
            request: Extract<FactRequest, { kind: 'commit_history' }>;
          } => t.request.kind === 'commit_history',
        )
        .map((t) => ({
          request: t.request,
          refs: all(
            'SELECT r.data_json FROM activity_refs r JOIN task_refs t ON t.repository_id=r.repository_id AND t.ref_id=r.id WHERE t.task_id=? ORDER BY r.id',
            t.id,
          ).map((r) => parse(r.data_json)),
          pages: Number(
            get(
              'SELECT COUNT(*) AS n FROM collection_pages WHERE task_id=?',
              t.id,
            )?.n,
          ),
          state: t.state as ActivityCoverage['state'],
          reason: t.reason,
          evidenceIds: all(
            'SELECT id FROM collection_pages WHERE task_id=? ORDER BY id',
            t.id,
          ).map((r) => `page:${r.id}`),
        }));
      return {
        revision: Number(row.facts_revision),
        candidate,
        observations,
        commits,
        coverage,
        inspectionUntil:
          (get('SELECT until FROM inspections WHERE repository_id=?', id)
            ?.until as string | undefined) ?? null,
      };
    },
    beginInspection(id, until) {
      candidateRow(id);
      tx(() => {
        if (
          Number(
            run('INSERT OR IGNORE INTO inspections VALUES (?,?)', id, until)
              .changes,
          )
        )
          bump(id);
      });
    },
    syncTasks(id, requests) {
      candidateRow(id);
      if (requests.some((r) => r.repositoryId !== id))
        throw new Error('Request repository does not match candidate');
      const until = get(
        'SELECT until FROM inspections WHERE repository_id=?',
        id,
      )?.until;
      if (
        until &&
        requests.some((r) => r.kind === 'commit_history' && r.until !== until)
      )
        throw new Error('Activity request upper bound differs from inspection');
      tx(() => {
        let changed = false;
        const desired = new Set(requests.map(hash));
        for (const r of all(
          'SELECT * FROM collection_tasks WHERE repository_id=?',
          id,
        )) {
          if (!desired.has(String(r.id)) && r.state !== 'cancelled') {
            run(
              "UPDATE collection_tasks SET state='cancelled' WHERE id=?",
              String(r.id),
            );
            changed = true;
          }
        }
        for (const request of requests) {
          const key = hash(request);
          const old = get('SELECT * FROM collection_tasks WHERE id=?', key);
          if (!old) {
            run(
              'INSERT INTO collection_tasks VALUES (?,?,?, ?,NULL,NULL)',
              key,
              id,
              canonicalJson(request),
              'pending',
            );
            changed = true;
          } else if (old.state === 'cancelled') {
            run(
              "UPDATE collection_tasks SET state='pending',reason=NULL WHERE id=?",
              key,
            );
            changed = true;
          }
        }
        if (changed) bump(id);
      });
    },
    readTasks() {
      return all(
        'SELECT * FROM collection_tasks ORDER BY repository_id,id',
      ).map(taskFromRow);
    },
    saveCollectionStep(task, result) {
      const current = taskFromRow(taskRow(task.id));
      if (
        current.repositoryId !== task.repositoryId ||
        canonicalJson(current.request) !== canonicalJson(task.request)
      )
        throw new Error('Task does not match stored request');
      if (current.state === 'cancelled')
        throw new Error('Collection task is cancelled');
      const taskIsStale =
        current.state !== task.state ||
        canonicalJson(current.checkpoint) !== canonicalJson(task.checkpoint);
      const resultIsCurrent =
        current.state === result.state &&
        canonicalJson(current.checkpoint) ===
          canonicalJson(result.checkpoint) &&
        current.reason === result.reason;
      if (taskIsStale && !resultIsCurrent)
        throw new Error('Collection task checkpoint is obsolete');
      if (
        result.commits.some((c) => c.repositoryId !== task.repositoryId) ||
        result.repositoryObservations.some(
          (o) => o.repositoryId !== task.repositoryId,
        )
      )
        throw new Error('Collection fact repository mismatch');
      tx(() => {
        let changed = false;
        const id = task.repositoryId;
        for (const o of result.repositoryObservations)
          changed = observation(o) || changed;
        const invocation = get(
          'SELECT id FROM invocations ORDER BY rowid DESC LIMIT 1',
        );
        const examined = (kind: string, factId: string) => {
          if (invocation)
            run(
              'INSERT OR IGNORE INTO collection_fact_invocations VALUES (?,?,?,?)',
              id,
              String(invocation.id),
              kind,
              factId,
            );
        };
        const refs = [
          ...result.refs,
          ...result.commits.flatMap((c) => c.refs ?? []),
        ];
        for (const ref of refs) {
          const key = hash(ref);
          examined('ref', key);
          changed =
            Number(
              run(
                'INSERT OR IGNORE INTO activity_refs VALUES (?,?,?)',
                id,
                key,
                canonicalJson(ref),
              ).changes,
            ) > 0 || changed;
          changed =
            Number(
              run(
                'INSERT OR IGNORE INTO task_refs VALUES (?,?,?)',
                task.id,
                id,
                key,
              ).changes,
            ) > 0 || changed;
        }
        for (const c of result.commits) {
          const { refs: membership, ...fact } = c;
          examined('commit', c.sha);
          changed =
            Number(
              run(
                'INSERT OR IGNORE INTO activity_commits VALUES (?,?,?)',
                id,
                c.sha,
                canonicalJson(fact),
              ).changes,
            ) > 0 || changed;
          for (const ref of membership ?? result.refs)
            changed =
              Number(
                run(
                  'INSERT OR IGNORE INTO activity_commit_refs VALUES (?,?,?)',
                  id,
                  hash(ref),
                  c.sha,
                ).changes,
              ) > 0 || changed;
        }
        if (result.response) {
          const key = hash({ task: task.id, response: result.response });
          changed =
            Number(
              run(
                'INSERT OR IGNORE INTO collection_pages VALUES (?,?,?)',
                key,
                task.id,
                canonicalJson(result.response),
              ).changes,
            ) > 0 || changed;
        }
        if (
          current.state !== result.state ||
          canonicalJson(current.checkpoint) !==
            canonicalJson(result.checkpoint) ||
          current.reason !== result.reason
        ) {
          run(
            'UPDATE collection_tasks SET state=?,checkpoint_json=?,reason=? WHERE id=?',
            result.state,
            result.checkpoint ? canonicalJson(result.checkpoint) : null,
            result.reason,
            task.id,
          );
          changed = true;
        }
        if (changed) bump(id);
      });
    },
    reserveActivityAttempt(taskId, invocationId, limit) {
      if (!Number.isInteger(limit) || limit <= 0)
        throw new Error('Invalid request budget');
      const task = taskFromRow(taskRow(taskId));
      if (task.request.kind !== 'commit_history')
        throw new Error('Activity reservation requires commit history');
      let reservationId: number | undefined;
      tx(() => {
        const inv = get('SELECT * FROM invocations WHERE id=?', invocationId);
        if (!inv) throw new Error('Unknown invocation');
        const limits = parse<CollectionLimits>(inv.limits_json);
        const count = Number(
          get(
            "SELECT COUNT(*) AS n FROM collection_attempts WHERE repository_id=? AND invocation_id=? AND kind='activity'",
            task.repositoryId,
            invocationId,
          )?.n,
        );
        if (count >= Math.min(limit, limits.maxActivityRequestsPerCandidate))
          throw new BudgetExhaustedError('request_budget');
        const elapsed = Number(
          get(
            'SELECT COALESCE(SUM(d.duration_ms),0) AS n FROM collection_durations d JOIN collection_tasks t ON t.id=d.task_id WHERE t.repository_id=? AND d.invocation_id=?',
            task.repositoryId,
            invocationId,
          )?.n,
        );
        if (
          limits.maxActivityDurationMs !== null &&
          elapsed >= limits.maxActivityDurationMs
        )
          throw new BudgetExhaustedError('duration_budget');
        reservationId = Number(
          run(
            'INSERT INTO collection_attempts (task_id,repository_id,invocation_id,kind) VALUES (?,?,?,?)',
            taskId,
            task.repositoryId,
            invocationId,
            'activity',
          ).lastInsertRowid,
        );
      });
      if (reservationId !== undefined)
        ownedReservations.set(taskId, reservationId);
    },
    saveAttempt(taskId, event) {
      taskRow(taskId);
      const reservationId = ownedReservations.get(taskId);
      if (reservationId === undefined)
        throw new Error('No reserved activity attempt owned by this execution');
      const updated = run(
        'UPDATE collection_attempts SET event_json=? WHERE id=? AND task_id=? AND event_json IS NULL',
        canonicalJson(event),
        reservationId,
        taskId,
      );
      if (Number(updated.changes) !== 1)
        throw new Error('No reserved activity attempt owned by this execution');
      ownedReservations.delete(taskId);
    },
    saveMetadataAttempt(invocationId, repositoryIds, event) {
      for (const id of repositoryIds) candidateRow(id);
      run(
        'INSERT INTO collection_attempts (invocation_id,kind,targets_json,event_json) VALUES (?,?,?,?)',
        invocationId,
        'metadata',
        canonicalJson([...new Set(repositoryIds)].sort((a, b) => a - b)),
        canonicalJson(event),
      );
    },
    recordCollectionDuration(taskId, invocationId, durationMs) {
      taskRow(taskId);
      if (!Number.isFinite(durationMs) || durationMs < 0)
        throw new Error('Invalid collection duration');
      run(
        'INSERT INTO collection_durations VALUES (?,?,?)',
        taskId,
        invocationId,
        durationMs,
      );
    },
    saveEvaluation(id, evaluation, revision) {
      tx(() => {
        if (Number(candidateRow(id).facts_revision) !== revision)
          throw new Error('Evaluation facts revision is obsolete');
        run(
          'INSERT INTO evaluations VALUES (?,?,?) ON CONFLICT(repository_id) DO UPDATE SET facts_revision=excluded.facts_revision,data_json=excluded.data_json',
          id,
          revision,
          canonicalJson(evaluation),
        );
      });
    },
    startInvocation(limits, now) {
      validateLimits(limits);
      const id = randomUUID();
      run(
        'INSERT INTO invocations VALUES (?,?,?)',
        id,
        canonicalJson(limits),
        now,
      );
      return id;
    },
    finish(input) {
      runRow();
      run('UPDATE runs SET ended_at=?,state=?', input.endedAt, input.state);
    },
    async withReadSnapshot(work) {
      if (snapshot) throw new Error('Nested snapshots are unsupported');
      db.exec('BEGIN DEFERRED');
      snapshot = true;
      try {
        const result = await work(store);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        snapshot = false;
      }
    },
    readCollectionSummary() {
      const attempts = all('SELECT * FROM collection_attempts ORDER BY id');
      const durations = all(
        'SELECT d.*,t.repository_id FROM collection_durations d JOIN collection_tasks t ON t.id=d.task_id',
      );
      const metrics = (
        kind: string,
        invocationId?: string,
        repositoryId?: number,
      ): RequestMetrics => {
        const rows = attempts.filter(
          (r) =>
            r.kind === kind &&
            (!invocationId || r.invocation_id === invocationId) &&
            (repositoryId === undefined ||
              Number(r.repository_id) === repositoryId),
        );
        const events = rows
          .filter((r) => r.event_json !== null)
          .map((r) => parse<HttpAttemptEvent>(r.event_json));
        const bytes =
          events.length === rows.length &&
          events.every((e) => e.responseBytes !== null)
            ? events.reduce((n, e) => n + (e.responseBytes ?? 0), 0)
            : null;
        // A global rateLimitUsed counter cannot establish request-specific cost.
        return {
          attempts: rows.length,
          retries: events.filter((e) => e.attempt > 1).length,
          responseBytes: rows.length ? bytes : null,
          waitMs: events.reduce((n, e) => n + e.waitMs, 0),
          activeDurationMs:
            kind === 'activity'
              ? durations
                  .filter(
                    (d) =>
                      (!invocationId || d.invocation_id === invocationId) &&
                      (repositoryId === undefined ||
                        Number(d.repository_id) === repositoryId),
                  )
                  .reduce((n, d) => n + Number(d.duration_ms), 0)
              : events.reduce(
                  (n, e) => n + e.finishedAt - e.startedAt + e.waitMs,
                  0,
                ),
          rateLimitCost: null,
        };
      };
      const required = {
        pending: 0,
        failed: 0,
        limited: 0,
        pendingEvaluations: 0,
      };
      const unknownReasons: Record<string, number> = {};
      for (const t of store.readTasks()) {
        if (
          t.state === 'pending' ||
          t.state === 'failed' ||
          t.state === 'limited'
        )
          required[t.state]++;
        if (t.state !== 'cancelled' && t.reason)
          unknownReasons[t.reason] = (unknownReasons[t.reason] ?? 0) + 1;
      }
      for (const c of candidates())
        if (c.evaluationRevision !== c.factsRevision)
          required.pendingEvaluations++;
      const keys = new Map<
        string,
        { repositoryId: number; invocationId: string }
      >();
      for (const a of attempts)
        if (a.kind === 'activity')
          keys.set(`${a.repository_id}:${a.invocation_id}`, {
            repositoryId: Number(a.repository_id),
            invocationId: String(a.invocation_id),
          });
      for (const d of durations)
        keys.set(`${d.repository_id}:${d.invocation_id}`, {
          repositoryId: Number(d.repository_id),
          invocationId: String(d.invocation_id),
        });
      return {
        activity: metrics('activity'),
        metadata: metrics('metadata'),
        required,
        unknownReasons,
        perCandidate: [...keys.values()].map((k) => ({
          ...k,
          activity: metrics('activity', k.invocationId, k.repositoryId),
          commitsExamined: Number(
            get(
              "SELECT COUNT(*) AS n FROM collection_fact_invocations WHERE repository_id=? AND invocation_id=? AND kind='commit'",
              k.repositoryId,
              k.invocationId,
            )?.n,
          ),
          refsExamined: Number(
            get(
              "SELECT COUNT(*) AS n FROM collection_fact_invocations WHERE repository_id=? AND invocation_id=? AND kind='ref'",
              k.repositoryId,
              k.invocationId,
            )?.n,
          ),
        })),
        invocations: all('SELECT * FROM invocations ORDER BY rowid').map(
          (i) => ({
            id: String(i.id),
            limits: parse(i.limits_json),
            activity: metrics('activity', String(i.id)),
            metadata: metrics('metadata', String(i.id)),
          }),
        ),
      };
    },
    close() {
      db.close();
    },
  };
  return store;
}
