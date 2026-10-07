import { describe, expect, it, vi } from 'vitest';
import { createActivityHooks } from '../src/discovery/collection.js';
import { createActivityClient } from '../src/discovery/collectors/github-activity.js';
import { DEFAULT_COLLECTION_LIMITS } from '../src/discovery/collectors/types.js';
import type { EligibilityRule } from '../src/discovery/eligibility/types.js';
import { runProtocolDiscovery } from '../src/discovery/protocol-runner.js';
import { openProtocolStore } from '../src/discovery/storage/protocol-store.js';
import {
  commitFact,
  humanActivityRule,
  restCommitPayload,
} from './protocol-helpers.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}
const now = () => '2026-10-06T12:00:00Z';
function fixture(rules: EligibilityRule[] = [humanActivityRule()]) {
  const store = openProtocolStore(':memory:');
  const query = {
    id: 'q',
    endpoint: 'repositories' as const,
    strategy: 'technology' as const,
    q: 'language:TypeScript',
    rationale: 'test',
  };
  store.createRun({
    config: {
      kind: 'protocol',
      catalog: { version: 3, queries: [query] },
      protocol: { version: 1, eligibility: rules },
    },
    subqueries: [
      {
        id: 'q:1',
        queryId: 'q',
        endpoint: 'repositories',
        strategy: 'technology',
        q: query.q,
        partitionLabel: 'all',
      },
    ],
    startedAt: now(),
    expansionDate: '2026-10-06',
    limits: DEFAULT_COLLECTION_LIMITS,
  });
  const client = {
    search: vi.fn(async () => ({
      totalCount: 1,
      incomplete: false,
      hasNext: false,
      hits: [
        {
          candidate: {
            id: 1,
            nodeId: 'node1',
            fullName: 'owner/repo',
            url: 'https://github.com/owner/repo',
            metadata: { pushed_at: now() },
          },
          path: null,
          url: 'https://github.com/owner/repo',
        },
      ],
    })),
  };
  const metadataClient = {
    fetchRepositories: vi.fn(async () => [
      {
        repositoryId: 1,
        status: 'ok' as const,
        data: {
          nameWithOwner: 'owner/current',
          defaultBranchRef: { name: 'main', target: { oid: 'a'.repeat(40) } },
        },
        reason: null,
      },
    ]),
  };
  const activity = {
    readBranch: vi.fn(),
    listBranches: vi.fn(async () => ({
      items: [],
      hasNext: false,
      observedAt: now(),
      requestUrl: 'branches',
      raw: [],
    })),
    listCommits: vi.fn(
      async (
        _target: unknown,
        _sha: string,
        _interval: unknown,
        _page: number,
        _signal: AbortSignal,
      ) => ({
        items: [commitFact()],
        hasNext: false,
        observedAt: now(),
        requestUrl: 'commits',
        raw: [],
      }),
    ),
  };
  const options = {
    store,
    client,
    metadataClient,
    makeActivityClient: vi.fn<
      (
        task: import('../src/discovery/collectors/types.js').CollectionTask,
        invocationId: string,
      ) => import('../src/discovery/collectors/types.js').ActivityClient
    >(() => activity),
    limits: DEFAULT_COLLECTION_LIMITS,
    signal: new AbortController().signal,
    now,
  };
  return { store, options, activity };
}
describe('protocol runner', () => {
  it('no_protocol_never_collects_activity', async () => {
    const { store, options } = fixture([]);
    const result = await runProtocolDiscovery(options);
    expect(result.run.state).toBe('complete');
    expect(options.makeActivityClient).not.toHaveBeenCalled();
    expect(options.metadataClient.fetchRepositories).not.toHaveBeenCalled();
    expect(store.readCandidateFacts(1).inspectionUntil).toBeNull();
    store.close();
  });
  it('search_metadata_does_not_satisfy_commit_rule and human_merge_stops_without_pr_requests', async () => {
    const { store, options, activity } = fixture();
    const result = await runProtocolDiscovery(options);
    expect(result.run.state).toBe('complete');
    expect(options.metadataClient.fetchRepositories).toHaveBeenCalledOnce();
    expect(activity.listCommits).toHaveBeenCalledOnce();
    expect(activity.listCommits.mock.calls[0]?.[0]).toMatchObject({
      fullName: 'owner/current',
    });
    expect(activity.listBranches).not.toHaveBeenCalled();
    expect([...store.iterateCandidates()][0]?.evaluation?.status).toBe('pass');
    store.close();
  });
  it('resume_skips_complete_search_and_fact_pages', async () => {
    const { store, options, activity } = fixture();
    await runProtocolDiscovery(options);
    await runProtocolDiscovery(options);
    expect(options.client.search).toHaveBeenCalledOnce();
    expect(activity.listCommits).toHaveBeenCalledOnce();
    expect(store.getRun().invocations).toHaveLength(2);
    store.close();
  });
  it('failed_last_push_cancels_commit_work', async () => {
    const { store, options, activity } = fixture([
      { id: 'push', type: 'last_push', since: '2027-01-01' },
      humanActivityRule(),
    ]);
    const result = await runProtocolDiscovery(options);
    expect(result.run.state).toBe('complete');
    expect([...store.iterateCandidates()][0]?.evaluation?.status).toBe('fail');
    expect(activity.listCommits).not.toHaveBeenCalled();
    store.close();
  });
  it('unknown_author_with_complete_coverage_is_complete_run', async () => {
    const { store, options, activity } = fixture();
    activity.listCommits.mockResolvedValue({
      items: [
        commitFact({ author: { name: null, email: null, account: null } }),
      ],
      hasNext: false,
      observedAt: now(),
      requestUrl: 'commits',
      raw: [],
    });
    const result = await runProtocolDiscovery(options);
    expect(result.run.state).toBe('complete');
    expect(
      [...store.iterateCandidates()][0]?.evaluation?.rules[0]?.reason,
    ).toBe('author_indeterminate');
    expect((await runProtocolDiscovery(options)).run.state).toBe('complete');
    expect(activity.listCommits).toHaveBeenCalledOnce();
    store.close();
  });
  it('budget_is_partial_not_fail and retained client preserves pacing', async () => {
    const { store, options } = fixture();
    let clock = Date.parse(now());
    options.now = () => new Date(clock).toISOString();
    options.limits = { ...DEFAULT_COLLECTION_LIMITS, commitsPerPage: 1 };
    const payload = restCommitPayload();
    payload.author = { login: 'robot', type: 'Bot' };
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify([payload])),
    );
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    options.makeActivityClient = vi.fn((task, invocationId) =>
      createActivityClient(
        { token: 'test', fetchFn, now: () => clock, sleep },
        options.limits,
        createActivityHooks(store, task, invocationId, options.limits),
      ),
    );
    const result = await runProtocolDiscovery(options);
    expect(result.run.state).toBe('partial');
    expect([...store.iterateCandidates()][0]?.evaluation?.status).toBe(
      'unknown',
    );
    expect(store.readCollectionSummary().activity.attempts).toBe(20);
    expect(fetchFn).toHaveBeenCalledTimes(20);
    expect(options.makeActivityClient).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalled();
    store.close();
  });
  it('duration_limit_including_http_wait_is_partial', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(now()));
      const { store, options } = fixture();
      options.now = () => new Date(Date.now()).toISOString();
      options.limits = {
        ...DEFAULT_COLLECTION_LIMITS,
        maxActivityDurationMs: 100,
      };
      const fetchFn = vi.fn<typeof fetch>(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      );
      options.makeActivityClient = vi.fn((task, invocationId) =>
        createActivityClient(
          { token: 'test', fetchFn, now: Date.now, sleep: async () => {} },
          options.limits,
          createActivityHooks(store, task, invocationId, options.limits),
        ),
      );
      const running = runProtocolDiscovery(options);
      await vi.advanceTimersByTimeAsync(100);
      const result = await running;
      expect(result.run.state).toBe('partial');
      expect(fetchFn).toHaveBeenCalledOnce();
      const task = store
        .readTasks()
        .find((t) => t.request.kind === 'commit_history');
      expect(task?.state).toBe('limited');
      expect(task?.checkpoint).toBeNull();
      expect(store.readCollectionSummary().activity.activeDurationMs).toBe(100);
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });
  it('failed_metadata_is_not_retried_and_never_uses_discovery_name', async () => {
    const { store, options, activity } = fixture();
    options.metadataClient.fetchRepositories.mockRejectedValue(
      new Error('unavailable'),
    );
    const result = await runProtocolDiscovery(options);
    expect(result.run.state).toBe('partial');
    expect(options.metadataClient.fetchRepositories).toHaveBeenCalledOnce();
    expect(activity.listCommits).not.toHaveBeenCalled();
    store.close();
  });
  it('aborted_search_retains_pending_rule_work', async () => {
    const { store, options } = fixture();
    const controller = new AbortController();
    options.signal = controller.signal;
    const search = required(options.client.search.getMockImplementation());
    options.client.search.mockImplementation(async () => {
      const page = await search();
      controller.abort();
      return page;
    });
    const result = await runProtocolDiscovery(options);
    expect(result.run.state).toBe('partial');
    expect(store.readTasks().some((t) => t.state === 'pending')).toBe(true);
    expect([...store.iterateCandidates()][0]?.evaluation?.status).toBe(
      'unknown',
    );
    store.close();
  });
  it('persisted_unfinished_invocation_resume_gets_fresh_budget', async () => {
    const { store, options } = fixture();
    const subquery = required(store.getSubqueries()[0]);
    store.savePage(
      subquery,
      1,
      await options.client.search(),
      { subqueryId: subquery.id, nextPage: null, state: 'complete' },
      now(),
    );
    store.beginInspection(1, now());
    store.syncTasks(1, [
      {
        kind: 'commit_history',
        repositoryId: 1,
        since: '2025-04-01T00:00:00Z',
        until: now(),
        branches: 'all',
      },
    ]);
    const task = required(store.readTasks()[0]);
    const initial = required(store.getRun().invocations[0]).id;
    for (let i = 0; i < 20; i++)
      store.reserveActivityAttempt(task.id, initial, 20);
    const result = await runProtocolDiscovery(options);
    expect(result.run.invocations).toHaveLength(2);
    expect(result.run.invocations[1]?.id).not.toBe(initial);
    expect(result.run.state).toBe('complete');
    expect(options.client.search).toHaveBeenCalledOnce();
    store.close();
  });
  it('facts_revision_changes_require_reevaluation', async () => {
    const { store, options, activity } = fixture();
    activity.listCommits.mockResolvedValue({
      items: [
        commitFact({ author: { name: null, email: null, account: null } }),
      ],
      hasNext: false,
      observedAt: now(),
      requestUrl: 'commits',
      raw: [],
    });
    await runProtocolDiscovery(options);
    const previous = required([...store.iterateCandidates()][0]);
    const task = required(
      store.readTasks().find((t) => t.request.kind === 'commit_history'),
    );
    store.saveCollectionStep(task, {
      repositoryObservations: [],
      refs: [],
      commits: [commitFact({ sha: 'b'.repeat(40) })],
      response: null,
      checkpoint: task.checkpoint,
      state: 'complete',
      reason: null,
    });
    expect([...store.iterateCandidates()][0]?.factsRevision).toBeGreaterThan(
      previous.factsRevision,
    );
    await runProtocolDiscovery(options);
    const candidate = required([...store.iterateCandidates()][0]);
    expect(candidate.evaluation?.status).toBe('pass');
    expect(candidate.evaluationRevision).toBe(candidate.factsRevision);
    expect(activity.listCommits).toHaveBeenCalledOnce();
    store.close();
  });
  it('search_and_collection_overlap_without_starvation', async () => {
    const { store, options, activity } = fixture();
    let finishSearch = () => {};
    const collectionObserved = new Promise<void>((resolve) => {
      finishSearch = resolve;
    });
    const page = await options.client.search();
    options.client.search.mockReset();
    options.client.search.mockImplementationOnce(async () => ({
      ...page,
      hasNext: true,
    }));
    options.client.search.mockImplementationOnce(async () => {
      await collectionObserved;
      return { ...page, hits: [] };
    });
    const commits = required(activity.listCommits.getMockImplementation());
    activity.listCommits.mockImplementation(async (...args) => {
      const result = await commits(...args);
      finishSearch();
      return result;
    });
    const result = await runProtocolDiscovery(options);
    expect(result.run.state).toBe('complete');
    expect(options.client.search).toHaveBeenCalledTimes(2);
    expect(activity.listCommits).toHaveBeenCalledOnce();
    store.close();
  });
});
