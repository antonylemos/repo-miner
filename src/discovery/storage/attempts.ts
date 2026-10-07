import { canonicalJson } from '../catalog.js';
import {
  BudgetExhaustedError,
  type CollectionLimits,
} from '../collectors/types.js';
import { type DatabaseAccess, parseJson } from './database.js';
import type { DiscoveryStore } from './store.js';

type AttemptsMethods = Pick<
  DiscoveryStore,
  | 'reserveActivityAttempt'
  | 'saveAttempt'
  | 'saveMetadataAttempt'
  | 'recordCollectionDuration'
>;

/** Request attempts, their per-invocation budgets, and collection durations. */
export function createAttempts({
  get,
  run,
  tx,
  candidateRow,
  taskRow,
  taskFromRow,
}: DatabaseAccess): AttemptsMethods {
  // Only this connection's current transport attempt may complete its reservation.
  // Interrupted reservations remain persisted with unknown telemetry after resume.
  const ownedReservations = new Map<string, number>();

  return {
    reserveActivityAttempt(taskId, invocationId, limit) {
      if (!Number.isInteger(limit) || limit <= 0)
        throw new Error('Invalid request budget');

      const task = taskFromRow(taskRow(taskId));
      if (task.request.kind !== 'commit_history')
        throw new Error('Activity reservation requires commit history');

      let reservationId: number | undefined;
      tx(() => {
        const invocation = get(
          'SELECT * FROM invocations WHERE id = ?',
          invocationId,
        );
        if (!invocation) throw new Error('Unknown invocation');

        const limits = parseJson<CollectionLimits>(invocation.limits_json);
        const attemptCount = Number(
          get(
            "SELECT COUNT(*) AS n FROM collection_attempts WHERE repository_id = ? AND invocation_id = ? AND kind = 'activity'",
            task.repositoryId,
            invocationId,
          )?.n,
        );
        if (
          attemptCount >=
          Math.min(limit, limits.maxActivityRequestsPerCandidate)
        )
          throw new BudgetExhaustedError('request_budget');

        const elapsedMs = Number(
          get(
            `SELECT COALESCE(SUM(d.duration_ms), 0) AS n
             FROM collection_durations d
             JOIN collection_tasks t ON t.id = d.task_id
             WHERE t.repository_id = ? AND d.invocation_id = ?`,
            task.repositoryId,
            invocationId,
          )?.n,
        );
        if (
          limits.maxActivityDurationMs !== null &&
          elapsedMs >= limits.maxActivityDurationMs
        )
          throw new BudgetExhaustedError('duration_budget');

        reservationId = Number(
          run(
            'INSERT INTO collection_attempts (task_id, repository_id, invocation_id, kind) VALUES (?, ?, ?, ?)',
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
        'UPDATE collection_attempts SET event_json = ? WHERE id = ? AND task_id = ? AND event_json IS NULL',
        canonicalJson(event),
        reservationId,
        taskId,
      );
      if (Number(updated.changes) !== 1)
        throw new Error('No reserved activity attempt owned by this execution');

      ownedReservations.delete(taskId);
    },

    saveMetadataAttempt(invocationId, repositoryIds, event) {
      for (const repositoryId of repositoryIds) candidateRow(repositoryId);

      run(
        'INSERT INTO collection_attempts (invocation_id, kind, targets_json, event_json) VALUES (?, ?, ?, ?)',
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
        'INSERT INTO collection_durations (task_id, invocation_id, duration_ms) VALUES (?, ?, ?)',
        taskId,
        invocationId,
        durationMs,
      );
    },
  };
}
