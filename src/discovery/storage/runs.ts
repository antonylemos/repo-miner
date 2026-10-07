import { randomUUID } from 'node:crypto';
import { canonicalJson, catalogHash } from '../catalog.js';
import type { CollectionLimits } from '../collectors/types.js';
import { EVALUATOR_VERSIONS } from '../eligibility/evaluate.js';
import type { StudyConfig } from '../eligibility/types.js';
import { parseStudyConfig } from '../study-config.js';
import { type DatabaseAccess, hashOf, parseJson } from './database.js';
import type { DiscoveryStore, Run } from './store.js';

export function validateLimits(limits: CollectionLimits): void {
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

type RunMethods = Pick<
  DiscoveryStore,
  'createRun' | 'getRun' | 'getStudyConfig' | 'startInvocation' | 'finish'
>;

/** The single protocol run of a database and the invocations that execute it. */
export function createRuns({ get, all, run, tx }: DatabaseAccess): RunMethods {
  const runRow = () => {
    const row = get('SELECT * FROM runs LIMIT 1');
    if (!row) throw new Error('No protocol run has been created');

    return row;
  };

  const getRun = (): Run => {
    const row = runRow();
    const config = parseJson<StudyConfig>(row.config_json);

    return {
      id: String(row.id),
      catalog: config.catalog,
      protocol: config.protocol,
      catalogHash: String(row.catalog_hash),
      protocolHash: String(row.protocol_hash),
      evaluatorVersions: parseJson(row.versions_json),
      startedAt: String(row.started_at),
      expansionDate: String(row.expansion_date),
      endedAt: row.ended_at === null ? null : String(row.ended_at),
      state: row.state as Run['state'],
      invocations: all('SELECT * FROM invocations ORDER BY rowid').map(
        (invocation) => ({
          id: String(invocation.id),
          limits: parseJson(invocation.limits_json),
          startedAt: String(invocation.started_at),
        }),
      ),
    };
  };

  return {
    createRun(input) {
      const config = parseStudyConfig(
        input.config.catalog,
        input.config.protocol,
      );
      validateLimits(input.limits);
      if (get('SELECT id FROM runs LIMIT 1'))
        throw new Error('This database already contains a protocol run');

      tx(() => {
        run(
          `INSERT INTO runs (
             id, config_json, catalog_hash, protocol_hash, versions_json,
             started_at, expansion_date, ended_at, state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          randomUUID(),
          canonicalJson(config),
          catalogHash(config.catalog),
          hashOf(config.protocol),
          canonicalJson(EVALUATOR_VERSIONS),
          input.startedAt,
          input.expansionDate,
          'running',
        );

        config.catalog.queries.forEach((query, ordinal) => {
          run(
            `INSERT INTO queries (
               query_id, ordinal, strategy, endpoint, q, rationale, partition_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            query.id,
            ordinal,
            query.strategy,
            query.endpoint,
            query.q,
            query.rationale,
            query.partition ? JSON.stringify(query.partition) : null,
          );
        });

        input.subqueries.forEach((subquery, ordinal) => {
          run(
            `INSERT INTO subqueries (
               subquery_id, query_id, ordinal, q_effective, partition_label
             ) VALUES (?, ?, ?, ?, ?)`,
            subquery.id,
            subquery.queryId,
            ordinal,
            subquery.q,
            subquery.partitionLabel,
          );
          run(
            'INSERT INTO checkpoints (subquery_id, next_page, state, reason) VALUES (?, 1, ?, NULL)',
            subquery.id,
            'pending',
          );
        });

        run(
          'INSERT INTO invocations (id, limits_json, started_at) VALUES (?, ?, ?)',
          randomUUID(),
          canonicalJson(input.limits),
          input.startedAt,
        );
      });

      return getRun();
    },

    getRun,

    getStudyConfig() {
      return parseJson(runRow().config_json);
    },

    startInvocation(limits, now) {
      validateLimits(limits);
      const id = randomUUID();
      run(
        'INSERT INTO invocations (id, limits_json, started_at) VALUES (?, ?, ?)',
        id,
        canonicalJson(limits),
        now,
      );

      return id;
    },

    finish(input) {
      runRow();
      run(
        'UPDATE runs SET ended_at = ?, state = ?',
        input.endedAt,
        input.state,
      );
    },
  };
}
