import { describe, expect, it, vi } from 'vitest';
import { collectActivityStep } from '../src/discovery/collectors/activity.js';
import type {
  ActivityClient,
  CollectionTask,
} from '../src/discovery/collectors/types.js';
import type { CandidateFacts } from '../src/discovery/eligibility/types.js';

const signal = new AbortController().signal;
const sha = 'a'.repeat(40);
const ref = { name: 'main', headSha: sha, observedAt: '2026-10-06T12:00:00Z' };
const page = (items: unknown[], hasNext = false) => ({
  items,
  hasNext,
  observedAt: ref.observedAt,
  requestUrl: 'https://example.test',
  raw: items,
});
const facts = (): CandidateFacts => ({
  revision: 1,
  candidate: {
    id: 1,
    nodeId: 'N',
    fullName: 'old/repo',
    url: '',
    metadata: {},
  },
  observations: [
    {
      id: 'm',
      repositoryId: 1,
      source: 'enrichment',
      status: 'ok',
      observedAt: ref.observedAt,
      data: {
        nameWithOwner: 'new/repo',
        defaultBranchRef: { name: 'main', target: { oid: sha } },
      },
    },
  ],
  commits: [],
  coverage: [],
  inspectionUntil: ref.observedAt,
});
const task = (): CollectionTask => ({
  id: 't',
  repositoryId: 1,
  request: {
    kind: 'commit_history',
    repositoryId: 1,
    since: '2025-04-01T00:00:00Z',
    until: ref.observedAt,
    branches: 'all',
  },
  state: 'pending',
  reason: null,
  checkpoint: null,
});
const client = (): ActivityClient => ({
  readBranch: vi.fn(),
  listBranches: vi.fn().mockResolvedValue(page([])),
  listCommits: vi.fn().mockResolvedValue(page([])),
});
describe('activity collector', () => {
  it('should keep default-only missing identity unknown after nonempty enumeration', async () => {
    const f = facts();
    for (const observation of f.observations)
      observation.data.defaultBranchRef = null;
    const c = client();
    vi.mocked(c.listBranches).mockResolvedValue(
      page([{ ...ref, name: 'other' }]) as never,
    );
    const t = task();
    if (t.request.kind === 'commit_history') t.request.branches = 'default';
    const s = await collectActivityStep(t, f, c, signal);
    expect(s.state).toBe('failed');
    expect(s.reason).toBe('default_ref_metadata_missing');
  });
  it('should prioritiz default history and validated renamed identity before enumeration', async () => {
    const c = client();
    const t = task();
    const s = await collectActivityStep(t, facts(), c, signal);
    expect(c.listCommits).toHaveBeenCalledWith(
      { repositoryId: 1, nodeId: 'N', fullName: 'new/repo' },
      sha,
      {
        since: t.request.kind === 'commit_history' ? t.request.since : '',
        until: ref.observedAt,
      },
      1,
      signal,
    );
    expect(c.listBranches).not.toHaveBeenCalled();
    expect(s.state).toBe('pending');
  });
  it('should resume saved SHA and page despite changed or deleted metadata refs', async () => {
    const c = client();
    const t = task();
    t.checkpoint = {
      defaultRef: { ref, nextPage: 2, complete: false },
      defaultResolved: true,
      nextBranchesPage: 1,
      refsComplete: false,
      otherRefs: [],
    };
    const f = facts();
    for (const observation of f.observations)
      observation.data.defaultBranchRef = null;
    await collectActivityStep(t, f, c, signal);
    expect(c.listCommits).toHaveBeenCalledWith(
      expect.anything(),
      sha,
      { since: '2025-04-01T00:00:00Z', until: ref.observedAt },
      2,
      signal,
    );
  });
  it('should not treat errors or incomplete enumeration as absence', async () => {
    const f = facts();
    for (const observation of f.observations)
      observation.data.defaultBranchRef = null;
    const c = client();
    vi.mocked(c.listBranches).mockRejectedValue(new Error('deleted'));
    const s = await collectActivityStep(task(), f, c, signal);
    expect(s.state).toBe('failed');
    expect(s.checkpoint?.refsComplete).toBe(false);
  });
  it('should continue bot-only pages, retaining duplicate SHA ref membership', async () => {
    const c = client();
    const t = task();
    const commit = {
      repositoryId: 1,
      sha: 'b'.repeat(40),
      authoredDate: '2025-01-01T00:00:00Z',
      committedDate: ref.observedAt,
      author: {
        name: null,
        email: null,
        account: { login: 'robot', providerType: 'Bot' },
      },
      committer: { name: null, email: null, account: null },
      observedAt: ref.observedAt,
    };
    vi.mocked(c.listCommits)
      .mockResolvedValueOnce(page([commit, commit], true) as never)
      .mockResolvedValueOnce(
        page([
          {
            ...commit,
            author: {
              ...commit.author,
              account: { login: 'human', providerType: 'User' },
            },
          },
        ]) as never,
      );
    const first = await collectActivityStep(t, facts(), c, signal);
    expect(first.commits).toHaveLength(1);
    expect(first.commits[0]?.refs).toEqual([ref]);
    expect(first.checkpoint?.defaultRef?.nextPage).toBe(2);
    t.checkpoint = first.checkpoint;
    const second = await collectActivityStep(t, facts(), c, signal);
    expect(second.commits[0]?.author.account?.providerType).toBe('User');
    expect(second.checkpoint?.defaultRef?.complete).toBe(true);
  });
  it('should collect human evidence exclusively on another branch without default metadata', async () => {
    const f = facts();
    for (const observation of f.observations)
      observation.data.defaultBranchRef = null;
    const other = { ...ref, name: 'dependabot/npm/a', headSha: 'c'.repeat(40) };
    const human = {
      repositoryId: 1,
      sha: 'd'.repeat(40),
      authoredDate: ref.observedAt,
      committedDate: ref.observedAt,
      observedAt: ref.observedAt,
      author: {
        name: null,
        email: null,
        account: { login: 'person', providerType: 'User' },
      },
      committer: { name: null, email: null, account: null },
    };
    const c = client();
    const t = task();
    vi.mocked(c.listBranches).mockResolvedValue(page([other]) as never);
    vi.mocked(c.listCommits).mockResolvedValue(page([human]) as never);
    const enumeration = await collectActivityStep(t, f, c, signal);
    expect(enumeration.state).toBe('pending');
    expect(enumeration.commits).toEqual([]);
    t.checkpoint = enumeration.checkpoint;
    const history = await collectActivityStep(t, f, c, signal);
    expect(history.state).toBe('complete');
    expect(history.commits).toEqual([{ ...human, refs: [other] }]);
    expect(c.listCommits).toHaveBeenCalledWith(
      expect.anything(),
      other.headSha,
      { since: '2025-04-01T00:00:00Z', until: ref.observedAt },
      1,
      signal,
    );
  });
  it('should collect a recent ancestor even when the observed head commit is older than since', async () => {
    const f = facts();
    const identity = {
      name: null,
      email: null,
      account: { login: 'person', providerType: 'User' },
    };
    const oldHead = {
      repositoryId: 1,
      sha,
      authoredDate: '2024-01-01T00:00:00Z',
      committedDate: '2024-01-01T00:00:00Z',
      observedAt: ref.observedAt,
      author: identity,
      committer: identity,
      refs: [ref],
    };
    f.commits.push(oldHead);
    const ancestor = {
      ...oldHead,
      sha: 'e'.repeat(40),
      committedDate: '2026-01-01T00:00:00Z',
      refs: undefined,
    };
    const c = client();
    vi.mocked(c.listCommits).mockResolvedValue(page([ancestor]) as never);
    const s = await collectActivityStep(task(), f, c, signal);
    expect(c.listCommits).toHaveBeenCalledWith(
      expect.anything(),
      oldHead.sha,
      expect.anything(),
      1,
      signal,
    );
    expect(s.commits[0]?.committedDate).toBe(ancestor.committedDate);
    expect(s.commits[0]?.refs).toEqual([ref]);
  });
  it('should enumerate more than 100 refs and collects dependabot ancestry without filtering names', async () => {
    const c = client();
    const t = task();
    t.checkpoint = {
      defaultRef: { ref, nextPage: null, complete: true },
      defaultResolved: true,
      nextBranchesPage: 1,
      refsComplete: false,
      otherRefs: [],
    };
    vi.mocked(c.listBranches)
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 100 }, (_, i) => ({
            ...ref,
            name: `branch${i}`,
          })),
          true,
        ) as never,
      )
      .mockResolvedValueOnce(
        page([{ ...ref, name: 'dependabot/npm/a' }]) as never,
      );
    let s = await collectActivityStep(t, facts(), c, signal);
    expect(s.state).toBe('pending');
    expect(s.checkpoint?.nextBranchesPage).toBe(2);
    t.checkpoint = s.checkpoint;
    s = await collectActivityStep(t, facts(), c, signal);
    expect(s.checkpoint?.otherRefs).toHaveLength(101);
    t.checkpoint = s.checkpoint;
    t.checkpoint?.otherRefs.slice(0, 100).forEach((r) => {
      r.complete = true;
      r.nextPage = null;
    });
    s = await collectActivityStep(t, facts(), c, signal);
    expect(c.listCommits).toHaveBeenCalledWith(
      expect.anything(),
      sha,
      expect.anything(),
      1,
      signal,
    );
    expect(s.refs[0]?.name).toBe('dependabot/npm/a');
    expect(s.state).toBe('complete');
  });
  it('should require successful final enumeration before proving missing default', async () => {
    const c = client();
    const t = task();
    if (t.request.kind === 'commit_history') t.request.branches = 'default';
    const f = facts();
    for (const observation of f.observations)
      observation.data.defaultBranchRef = null;
    vi.mocked(c.listBranches)
      .mockResolvedValueOnce(page([], true) as never)
      .mockResolvedValueOnce(page([]) as never);
    const s = await collectActivityStep(t, f, c, signal);
    expect(s.state).toBe('pending');
    expect(s.checkpoint?.defaultResolved).toBe(false);
    t.checkpoint = s.checkpoint;
    expect((await collectActivityStep(t, f, c, signal)).state).toBe('complete');
  });
});
