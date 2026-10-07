import type {
  CollectionSummary,
  RequestMetrics,
} from '@/modules/discovery/model/collection.js';
import type {
  DiscoveryStore,
  StoredCandidate,
} from '@/modules/discovery/model/store.js';
import type { Row } from './connection.js';
import { type DatabaseAccess, parseJson } from './database.js';

type SummaryDependencies = Pick<DiscoveryStore, 'readTasks'> & {
  iterateCandidates(): Iterable<StoredCandidate>;
};

/** Request metrics, outstanding work and per-candidate cost of a collection. */
export function createSummary(
  { all }: DatabaseAccess,
  { readTasks, iterateCandidates }: SummaryDependencies,
): Pick<DiscoveryStore, 'readCollectionSummary'> {
  return {
    readCollectionSummary(): CollectionSummary {
      // Attempts are aggregated per (kind, invocation, repository) in SQL.
      // A group has complete bytes only if every attempt has a recorded event
      // with a non-null responseBytes; an interrupted reservation has no event.
      const attemptGroups = all(
        `SELECT kind, invocation_id, repository_id,
                COUNT(*) AS attempts,
                SUM(json_extract(event_json, '$.attempt') > 1) AS retries,
                COUNT(json_extract(event_json, '$.responseBytes')) AS bytes_known,
                COALESCE(SUM(json_extract(event_json, '$.responseBytes')), 0) AS response_bytes,
                COALESCE(SUM(json_extract(event_json, '$.waitMs')), 0) AS wait_ms,
                COALESCE(SUM(
                  json_extract(event_json, '$.finishedAt')
                  - json_extract(event_json, '$.startedAt')
                  + json_extract(event_json, '$.waitMs')
                ), 0) AS elapsed_ms
         FROM collection_attempts
         GROUP BY kind, invocation_id, repository_id
         ORDER BY MIN(id)`,
      );
      const durationGroups = all(
        `SELECT d.invocation_id, t.repository_id,
                SUM(d.duration_ms) AS duration_ms
         FROM collection_durations d
         JOIN collection_tasks t ON t.id = d.task_id
         GROUP BY d.invocation_id, t.repository_id
         ORDER BY MIN(d.rowid)`,
      );

      const metrics = (
        kind: string,
        invocationId?: string,
        repositoryId?: number,
      ): RequestMetrics => {
        const groups = attemptGroups.filter(
          (group) =>
            group.kind === kind &&
            (!invocationId || group.invocation_id === invocationId) &&
            (repositoryId === undefined ||
              Number(group.repository_id) === repositoryId),
        );
        const sum = (rows: Row[], column: string) =>
          rows.reduce((total, row) => total + Number(row[column]), 0);
        const attempts = sum(groups, 'attempts');
        const bytesComplete = sum(groups, 'bytes_known') === attempts;

        // A global rateLimitUsed counter cannot establish request-specific cost.
        return {
          attempts,
          retries: sum(groups, 'retries'),
          responseBytes:
            attempts && bytesComplete ? sum(groups, 'response_bytes') : null,
          waitMs: sum(groups, 'wait_ms'),
          activeDurationMs:
            kind === 'activity'
              ? sum(
                  durationGroups.filter(
                    (group) =>
                      (!invocationId || group.invocation_id === invocationId) &&
                      (repositoryId === undefined ||
                        Number(group.repository_id) === repositoryId),
                  ),
                  'duration_ms',
                )
              : sum(groups, 'elapsed_ms'),
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
      for (const task of readTasks()) {
        if (
          task.state === 'pending' ||
          task.state === 'failed' ||
          task.state === 'limited'
        )
          required[task.state]++;
        if (task.state !== 'cancelled' && task.reason)
          unknownReasons[task.reason] = (unknownReasons[task.reason] ?? 0) + 1;
      }
      for (const candidate of iterateCandidates())
        if (candidate.evaluationRevision !== candidate.factsRevision)
          required.pendingEvaluations++;

      const candidateKeys = new Map<
        string,
        { repositoryId: number; invocationId: string }
      >();
      for (const group of attemptGroups)
        if (group.kind === 'activity')
          candidateKeys.set(`${group.repository_id}:${group.invocation_id}`, {
            repositoryId: Number(group.repository_id),
            invocationId: String(group.invocation_id),
          });
      for (const group of durationGroups)
        candidateKeys.set(`${group.repository_id}:${group.invocation_id}`, {
          repositoryId: Number(group.repository_id),
          invocationId: String(group.invocation_id),
        });

      // One grouped query replaces a pair of counts per candidate and invocation.
      const examinedCounts = new Map<string, number>();
      for (const row of all(
        `SELECT repository_id, invocation_id, kind, COUNT(*) AS n
         FROM collection_fact_invocations
         GROUP BY repository_id, invocation_id, kind`,
      ))
        examinedCounts.set(
          `${row.repository_id}:${row.invocation_id}:${row.kind}`,
          Number(row.n),
        );
      const countExamined = (
        kind: 'ref' | 'commit',
        repositoryId: number,
        invocationId: string,
      ) => examinedCounts.get(`${repositoryId}:${invocationId}:${kind}`) ?? 0;

      return {
        activity: metrics('activity'),
        metadata: metrics('metadata'),
        required,
        unknownReasons,
        perCandidate: [...candidateKeys.values()].map((key) => ({
          ...key,
          activity: metrics('activity', key.invocationId, key.repositoryId),
          commitsExamined: countExamined(
            'commit',
            key.repositoryId,
            key.invocationId,
          ),
          refsExamined: countExamined(
            'ref',
            key.repositoryId,
            key.invocationId,
          ),
        })),
        invocations: all('SELECT * FROM invocations ORDER BY rowid').map(
          (invocation) => ({
            id: String(invocation.id),
            limits: parseJson(invocation.limits_json),
            activity: metrics('activity', String(invocation.id)),
            metadata: metrics('metadata', String(invocation.id)),
          }),
        ),
      };
    },
  };
}
