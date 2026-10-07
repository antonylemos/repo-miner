import { commitEvidenceId } from '../eligibility/recent-commit.js';
import type { CandidateFacts, CommitFact } from '../eligibility/types.js';
import { isRecord } from '../http.js';
import {
  type ActivityCheckpoint,
  type ActivityClient,
  BudgetExhaustedError,
  type CollectionTask,
  type CollectorStep,
} from './types.js';

/** One provider operation, followed by a persistable checkpoint. Evaluation belongs to the caller. */
export async function collectActivityStep(
  task: CollectionTask,
  facts: CandidateFacts,
  client: ActivityClient,
  signal: AbortSignal,
): Promise<CollectorStep> {
  const checkpoint: ActivityCheckpoint = task.checkpoint
    ? structuredClone(task.checkpoint)
    : {
        defaultRef: null,
        defaultResolved: false,
        nextBranchesPage: 1,
        refsComplete: false,
        otherRefs: [],
      };
  const step: CollectorStep = {
    repositoryObservations: [],
    refs: [],
    commits: [],
    response: null,
    checkpoint,
    state: 'pending',
    reason: null,
  };
  if (
    task.request.kind !== 'commit_history' ||
    task.repositoryId !== facts.candidate.id ||
    task.request.repositoryId !== task.repositoryId
  )
    return { ...step, state: 'failed', reason: 'invalid_activity_request' };
  const request = task.request;
  const observations = facts.observations
    .filter((o) => o.repositoryId === task.repositoryId && o.status === 'ok')
    .sort(
      (a, b) =>
        b.observedAt.localeCompare(a.observedAt) || b.id.localeCompare(a.id),
    );
  const enriched = observations.find(
    (o) =>
      o.source === 'enrichment' && typeof o.data.nameWithOwner === 'string',
  );
  const target = {
    repositoryId: task.repositoryId,
    nodeId: facts.candidate.nodeId,
    fullName: enriched
      ? (enriched.data.nameWithOwner as string)
      : facts.candidate.fullName,
  };
  const metadata = observations.find(
    (o) => o.source === 'enrichment' && 'defaultBranchRef' in o.data,
  );
  const graphRef = metadata?.data.defaultBranchRef;
  const defaultName =
    isRecord(graphRef) && typeof graphRef.name === 'string'
      ? graphRef.name
      : observations.find((o) => typeof o.data.default_branch === 'string')
          ?.data.default_branch;
  const finish = () => {
    if (
      checkpoint.refsComplete &&
      !checkpoint.defaultRef &&
      checkpoint.otherRefs.length > 0
    ) {
      step.state = 'failed';
      step.reason = 'default_ref_metadata_missing';
      return step;
    }
    const historiesComplete =
      (!checkpoint.defaultRef || checkpoint.defaultRef.complete) &&
      (request.branches === 'default' ||
        checkpoint.otherRefs.every((r) => r.complete));
    if (
      checkpoint.defaultResolved &&
      historiesComplete &&
      (request.branches === 'default'
        ? checkpoint.defaultRef !== null || checkpoint.refsComplete
        : checkpoint.refsComplete)
    )
      step.state = 'complete';
    return step;
  };
  try {
    signal.throwIfAborted();
    if (
      !checkpoint.defaultResolved &&
      typeof defaultName === 'string' &&
      defaultName
    ) {
      const oid =
        isRecord(graphRef) && isRecord(graphRef.target)
          ? graphRef.target.oid
          : null;
      if (
        typeof oid === 'string' &&
        /^[a-fA-F0-9]{40}$/.test(oid) &&
        metadata
      ) {
        const ref = {
          name: defaultName,
          headSha: oid,
          observedAt: metadata.observedAt,
        };
        checkpoint.defaultRef = { ref, nextPage: 1, complete: false };
        checkpoint.defaultResolved = true;
        step.refs.push(ref);
      } else {
        const response = await client.readBranch(target, defaultName, signal);
        checkpoint.defaultRef = {
          ref: response.ref,
          nextPage: 1,
          complete: false,
        };
        checkpoint.defaultResolved = true;
        step.refs.push(response.ref);
        step.response = response;
        return finish();
      }
    }
    const history =
      checkpoint.defaultRef && !checkpoint.defaultRef.complete
        ? checkpoint.defaultRef
        : checkpoint.refsComplete && request.branches === 'all'
          ? checkpoint.otherRefs.find((r) => !r.complete)
          : undefined;
    if (history) {
      const response = await client.listCommits(
        target,
        history.ref.headSha,
        { since: request.since, until: request.until },
        history.nextPage ?? 1,
        signal,
      );
      step.response = response;
      step.refs = [history.ref];
      const unique = new Map<string, CommitFact>();
      for (const commit of response.items) {
        const key = commitEvidenceId(commit);
        const previous = unique.get(key);
        unique.set(key, {
          ...commit,
          refs: [
            ...(previous?.refs ?? commit.refs ?? []).filter(
              (r) =>
                r.name !== history.ref.name ||
                r.headSha !== history.ref.headSha,
            ),
            history.ref,
          ],
        });
      }
      step.commits = [...unique.values()];
      history.nextPage = response.hasNext ? (history.nextPage ?? 1) + 1 : null;
      history.complete = !response.hasNext;
      return finish();
    }
    if (!checkpoint.refsComplete) {
      const response = await client.listBranches(
        target,
        checkpoint.nextBranchesPage ?? 1,
        signal,
      );
      step.response = response;
      step.refs.push(...response.items);
      for (const ref of response.items) {
        if (!checkpoint.defaultResolved && ref.name === defaultName) {
          checkpoint.defaultRef = { ref, nextPage: 1, complete: false };
          checkpoint.defaultResolved = true;
        } else if (
          ref.name !== checkpoint.defaultRef?.ref.name &&
          !checkpoint.otherRefs.some((r) => r.ref.name === ref.name)
        )
          checkpoint.otherRefs.push({ ref, nextPage: 1, complete: false });
      }
      checkpoint.nextBranchesPage = response.hasNext
        ? (checkpoint.nextBranchesPage ?? 1) + 1
        : null;
      checkpoint.refsComplete = !response.hasNext;
      if (checkpoint.refsComplete && checkpoint.otherRefs.length === 0)
        checkpoint.defaultResolved = true;
      return finish();
    }
    return finish();
  } catch (error) {
    return {
      ...step,
      state: error instanceof BudgetExhaustedError ? 'limited' : 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
