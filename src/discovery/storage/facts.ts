import { canonicalJson } from '../catalog.js';
import type { CollectionTask } from '../collectors/types.js';
import type {
  ActivityCoverage,
  CommitFact,
  FactRequest,
  RefObservation,
  RepositoryObservation,
} from '../eligibility/types.js';
import { type DatabaseAccess, hashOf, parseJson } from './database.js';
import { createSearchData } from './search-data.js';
import type { DiscoveryStore, StoredCandidate } from './store.js';

type FactsMethods = Pick<
  DiscoveryStore,
  | 'iterateCandidates'
  | 'readCandidateFacts'
  | 'savePage'
  | 'beginInspection'
  | 'saveEvaluation'
>;

/** Candidates, the facts observed about them, and their protocol evaluations. */
export function createFacts(access: DatabaseAccess): FactsMethods {
  const {
    db,
    get,
    all,
    run,
    tx,
    insertIfAbsent,
    saveObservation,
    candidateRow,
    taskFromRow,
    bumpFactsRevision,
  } = access;

  function* iterateCandidates(
    repositoryId?: number,
  ): Generator<StoredCandidate> {
    const rows =
      repositoryId === undefined
        ? all('SELECT * FROM candidates ORDER BY repository_id')
        : all('SELECT * FROM candidates WHERE repository_id = ?', repositoryId);

    for (const row of rows) {
      const id = Number(row.repository_id);
      const firstRestHit = get(
        `SELECT h.* FROM hits h JOIN queries q ON q.query_id = h.query_id
         WHERE h.repository_id = ? AND q.endpoint = 'repositories'
         ORDER BY h.fetched_at, h.subquery_id, h.path LIMIT 1`,
        id,
      );
      const evaluation = get(
        'SELECT * FROM evaluations WHERE repository_id = ?',
        id,
      );

      yield {
        id,
        nodeId: String(row.node_id),
        fullName: String(firstRestHit?.full_name ?? row.full_name),
        url: String(firstRestHit?.repository_url ?? row.url),
        metadata: parseJson(firstRestHit?.metadata_json ?? row.metadata_json),
        firstSeenAt: String(row.first_seen_at),
        metadataObservedAt: String(
          firstRestHit?.fetched_at ?? row.first_seen_at,
        ),
        factsRevision: Number(row.facts_revision),
        evaluation: evaluation ? parseJson(evaluation.data_json) : null,
        evaluationRevision: evaluation
          ? Number(evaluation.facts_revision)
          : null,
      };
    }
  }

  const readCommits = (repositoryId: number) =>
    all(
      'SELECT * FROM activity_commits WHERE repository_id = ? ORDER BY sha',
      repositoryId,
    ).map((row) => ({
      ...parseJson<CommitFact>(row.data_json),
      refs: all(
        `SELECT r.data_json FROM activity_refs r
         JOIN activity_commit_refs c
           ON c.repository_id = r.repository_id AND c.ref_id = r.id
         WHERE c.repository_id = ? AND c.sha = ? ORDER BY r.id`,
        repositoryId,
        String(row.sha),
      ).map((ref) => parseJson<RefObservation>(ref.data_json)),
    }));

  const readCoverage = (repositoryId: number): ActivityCoverage[] =>
    all(
      "SELECT * FROM collection_tasks WHERE repository_id = ? AND state != 'cancelled' ORDER BY id",
      repositoryId,
    )
      .map(taskFromRow)
      .filter(
        (
          task,
        ): task is CollectionTask & {
          request: Extract<FactRequest, { kind: 'commit_history' }>;
        } => task.request.kind === 'commit_history',
      )
      .map((task) => ({
        request: task.request,
        refs: all(
          `SELECT r.data_json FROM activity_refs r
           JOIN task_refs t
             ON t.repository_id = r.repository_id AND t.ref_id = r.id
           WHERE t.task_id = ? ORDER BY r.id`,
          task.id,
        ).map((ref) => parseJson(ref.data_json)),
        pages: Number(
          get(
            'SELECT COUNT(*) AS n FROM collection_pages WHERE task_id = ?',
            task.id,
          )?.n,
        ),
        state: task.state as ActivityCoverage['state'],
        reason: task.reason,
        evidenceIds: all(
          'SELECT id FROM collection_pages WHERE task_id = ? ORDER BY id',
          task.id,
        ).map((page) => `page:${page.id}`),
      }));

  return {
    iterateCandidates,

    savePage(subquery, page, result, checkpoint, fetchedAt) {
      // Rebuilds the search writer with a wrapped transaction so that search
      // observations are recorded, and facts revisions bumped, inside the same
      // writer transaction as the page and its checkpoint.
      const writer = createSearchData(db, (saveSearchFacts) =>
        tx(() => {
          const pageExisted = get(
            'SELECT 1 FROM pages WHERE subquery_id = ? AND page = ?',
            subquery.id,
            page,
          );
          saveSearchFacts();
          if (pageExisted) return;

          const changedRepositories = new Set<number>();
          for (const hit of result.hits) {
            const repositoryId = hit.candidate.id;
            const observation: RepositoryObservation = {
              id: `search:${subquery.id}:${page}:${repositoryId}:${hashOf(hit.path)}`,
              repositoryId,
              source: 'search',
              observedAt: fetchedAt,
              status: 'ok',
              data: hit.candidate.metadata,
            };
            if (saveObservation(observation))
              changedRepositories.add(repositoryId);
          }
          changedRepositories.forEach(bumpFactsRevision);
        }),
      );

      writer.savePage(subquery, page, result, checkpoint, fetchedAt);
    },

    readCandidateFacts(repositoryId) {
      const row = candidateRow(repositoryId);
      const candidate = iterateCandidates(repositoryId).next().value;
      if (!candidate) throw new Error(`Unknown repository ${repositoryId}`);

      const observations = all(
        'SELECT data_json FROM repository_observations WHERE repository_id = ? ORDER BY rowid',
        repositoryId,
      ).map((observation) =>
        parseJson<RepositoryObservation>(observation.data_json),
      );
      const inspection = get(
        'SELECT until FROM inspections WHERE repository_id = ?',
        repositoryId,
      );

      return {
        revision: Number(row.facts_revision),
        candidate,
        observations,
        commits: readCommits(repositoryId),
        coverage: readCoverage(repositoryId),
        inspectionUntil: (inspection?.until as string | undefined) ?? null,
      };
    },

    beginInspection(repositoryId, until) {
      candidateRow(repositoryId);
      tx(() => {
        if (
          insertIfAbsent('inspections', { repository_id: repositoryId, until })
        )
          bumpFactsRevision(repositoryId);
      });
    },

    saveEvaluation(repositoryId, evaluation, factsRevision) {
      tx(() => {
        if (Number(candidateRow(repositoryId).facts_revision) !== factsRevision)
          throw new Error('Evaluation facts revision is obsolete');

        run(
          `INSERT INTO evaluations (repository_id, facts_revision, data_json)
           VALUES (?, ?, ?)
           ON CONFLICT(repository_id) DO UPDATE SET
             facts_revision = excluded.facts_revision,
             data_json = excluded.data_json`,
          repositoryId,
          factsRevision,
          canonicalJson(evaluation),
        );
      });
    },
  };
}
