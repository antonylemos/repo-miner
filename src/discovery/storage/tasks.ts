import { canonicalJson } from '../catalog.js';
import type { DatabaseAccess } from './database.js';
import { hashOf } from './database.js';
import type { DiscoveryStore } from './store.js';

type TasksMethods = Pick<
  DiscoveryStore,
  'syncTasks' | 'readTasks' | 'saveCollectionStep'
>;

/** Collection tasks, their checkpoints, and the facts each step collects. */
export function createTasks(access: DatabaseAccess): TasksMethods {
  const {
    get,
    all,
    run,
    tx,
    insertIfAbsent,
    saveObservation,
    candidateRow,
    taskRow,
    taskFromRow,
    bumpFactsRevision,
  } = access;

  return {
    syncTasks(repositoryId, requests) {
      candidateRow(repositoryId);
      if (requests.some((request) => request.repositoryId !== repositoryId))
        throw new Error('Request repository does not match candidate');

      const until = get(
        'SELECT until FROM inspections WHERE repository_id = ?',
        repositoryId,
      )?.until;
      if (
        until &&
        requests.some(
          (request) =>
            request.kind === 'commit_history' && request.until !== until,
        )
      )
        throw new Error('Activity request upper bound differs from inspection');

      tx(() => {
        let changed = false;
        const desiredIds = new Set(requests.map(hashOf));

        for (const task of all(
          'SELECT * FROM collection_tasks WHERE repository_id = ?',
          repositoryId,
        )) {
          if (!desiredIds.has(String(task.id)) && task.state !== 'cancelled') {
            run(
              "UPDATE collection_tasks SET state = 'cancelled' WHERE id = ?",
              String(task.id),
            );
            changed = true;
          }
        }

        for (const request of requests) {
          const taskId = hashOf(request);
          const existing = get(
            'SELECT * FROM collection_tasks WHERE id = ?',
            taskId,
          );

          if (!existing) {
            run(
              `INSERT INTO collection_tasks (
                 id, repository_id, request_json, state, checkpoint_json, reason
               ) VALUES (?, ?, ?, ?, NULL, NULL)`,
              taskId,
              repositoryId,
              canonicalJson(request),
              'pending',
            );
            changed = true;
          } else if (existing.state === 'cancelled') {
            run(
              "UPDATE collection_tasks SET state = 'pending', reason = NULL WHERE id = ?",
              taskId,
            );
            changed = true;
          }
        }

        if (changed) bumpFactsRevision(repositoryId);
      });
    },

    readTasks() {
      return all(
        'SELECT * FROM collection_tasks ORDER BY repository_id, id',
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
        result.commits.some(
          (commit) => commit.repositoryId !== task.repositoryId,
        ) ||
        result.repositoryObservations.some(
          (observation) => observation.repositoryId !== task.repositoryId,
        )
      )
        throw new Error('Collection fact repository mismatch');

      tx(() => {
        const repositoryId = task.repositoryId;
        let changed = false;
        // Every insert must run, so a result is recorded instead of short-circuiting.
        const recordChange = (inserted: boolean) => {
          if (inserted) changed = true;
        };

        for (const observation of result.repositoryObservations)
          recordChange(saveObservation(observation));

        const invocation = get(
          'SELECT id FROM invocations ORDER BY rowid DESC LIMIT 1',
        );
        const markExamined = (kind: 'ref' | 'commit', factId: string) => {
          if (invocation)
            insertIfAbsent('collection_fact_invocations', {
              repository_id: repositoryId,
              invocation_id: String(invocation.id),
              kind,
              fact_id: factId,
            });
        };

        const refs = [
          ...result.refs,
          ...result.commits.flatMap((commit) => commit.refs ?? []),
        ];
        for (const ref of refs) {
          const refId = hashOf(ref);
          markExamined('ref', refId);
          recordChange(
            insertIfAbsent('activity_refs', {
              repository_id: repositoryId,
              id: refId,
              data_json: canonicalJson(ref),
            }),
          );
          recordChange(
            insertIfAbsent('task_refs', {
              task_id: task.id,
              repository_id: repositoryId,
              ref_id: refId,
            }),
          );
        }

        for (const commit of result.commits) {
          const { refs: membership, ...fact } = commit;
          markExamined('commit', commit.sha);
          recordChange(
            insertIfAbsent('activity_commits', {
              repository_id: repositoryId,
              sha: commit.sha,
              data_json: canonicalJson(fact),
            }),
          );
          for (const ref of membership ?? result.refs)
            recordChange(
              insertIfAbsent('activity_commit_refs', {
                repository_id: repositoryId,
                ref_id: hashOf(ref),
                sha: commit.sha,
              }),
            );
        }

        if (result.response)
          recordChange(
            insertIfAbsent('collection_pages', {
              id: hashOf({ task: task.id, response: result.response }),
              task_id: task.id,
              data_json: canonicalJson(result.response),
            }),
          );

        if (
          current.state !== result.state ||
          canonicalJson(current.checkpoint) !==
            canonicalJson(result.checkpoint) ||
          current.reason !== result.reason
        ) {
          run(
            'UPDATE collection_tasks SET state = ?, checkpoint_json = ?, reason = ? WHERE id = ?',
            result.state,
            result.checkpoint ? canonicalJson(result.checkpoint) : null,
            result.reason,
            task.id,
          );
          changed = true;
        }

        if (changed) bumpFactsRevision(repositoryId);
      });
    },
  };
}
