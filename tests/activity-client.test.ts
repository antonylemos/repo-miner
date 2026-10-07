import { describe, expect, it, vi } from 'vitest';
import { createActivityClient } from '../src/discovery/collectors/github-activity.js';
import { DEFAULT_COLLECTION_LIMITS } from '../src/discovery/collectors/types.js';
import { restCommitPayload as commit } from './helpers.js';

const target = { repositoryId: 1, nodeId: 'R', fullName: 'owner/repo' };
const signal = new AbortController().signal;
const sha = 'a'.repeat(40);
const interval = {
  since: '2025-04-01T00:00:00Z',
  until: '2026-10-06T12:00:00Z',
};
const branch = { name: 'feature/slash', commit: { sha } };
function setup(body: unknown, link?: string, status = 200) {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: link ? { link } : {},
    }),
  );
  let now = Date.parse('2026-10-06T12:00:00Z');
  const beforeAttempt = vi.fn();
  const onAttemptFinished = vi.fn();
  const sleep = vi.fn(async (ms: number) => {
    now += ms;
  });
  const client = createActivityClient(
    { token: 'SECRET', fetchFn, now: () => now, sleep },
    DEFAULT_COLLECTION_LIMITS,
    { beforeAttempt, onAttemptFinished },
  );
  return { client, fetchFn, sleep, beforeAttempt, onAttemptFinished };
}
describe('activity REST client', () => {
  it('should reject transport redirects on every activity attempt without yielding absence', async () => {
    const s = setup([]);
    s.fetchFn.mockImplementation(async (_url, init) => {
      expect(init?.redirect).toBe('error');
      throw new TypeError('fetch failed: redirect');
    });
    await expect(s.client.listBranches(target, 1, signal)).rejects.toThrow(
      /redirect/,
    );
    expect(s.fetchFn).toHaveBeenCalledTimes(3);
    expect(
      s.fetchFn.mock.calls.every(
        ([url]) =>
          String(url) ===
          'https://api.github.com/repos/owner/repo/branches?per_page=100&page=1',
      ),
    ).toBe(true);
  });
  it('should treat an unexpected redirect response as an error', async () => {
    const s = setup([], undefined, 302);
    await expect(s.client.listBranches(target, 1, signal)).rejects.toThrow(
      /302/,
    );
    expect(s.fetchFn).toHaveBeenCalledOnce();
  });
  it.each(['sha', 'since', 'until', 'per_page'])(
    'should reject mutated commit pagination %s',
    async (parameter) => {
      const s = setup([commit()]);
      await s.client.listCommits(target, sha, interval, 1, signal);
      const next = new URL(String(s.fetchFn.mock.calls[0]?.[0]));
      next.searchParams.set('page', '2');
      next.searchParams.set(parameter, 'changed');
      s.fetchFn.mockResolvedValueOnce(
        new Response(JSON.stringify([commit()]), {
          headers: { link: `<${next}>; rel="next"` },
        }),
      );
      await expect(
        s.client.listCommits(target, sha, interval, 1, signal),
      ).rejects.toThrow(/pagination/i);
    },
  );
  it('should accept matching next pagination but still constructs its next request locally', async () => {
    const s = setup(
      [branch],
      '<https://api.github.com/repos/owner/repo/branches?page=2&per_page=100>; rel="next"',
    );
    expect((await s.client.listBranches(target, 1, signal)).hasNext).toBe(true);
    expect(s.fetchFn).toHaveBeenCalledOnce();
    expect(new URL(String(s.fetchFn.mock.calls[0]?.[0])).origin).toBe(
      'https://api.github.com',
    );
    expect(s.fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer SECRET',
    });
  });
  it.each([
    '2025-04-01T00:00:00',
    '2025-04-01T00:00:00+24:00',
    '2025-04-01T00:00:00+00:60',
    '2025-13-01T00:00:00Z',
    '2025-04-31T00:00:00Z',
  ])('should reject invalid date %s', async (date) => {
    const value = commit();
    value.commit.committer.date = date;
    await expect(
      setup([value]).client.listCommits(target, sha, interval, 1, signal),
    ).rejects.toThrow(/invalid/i);
  });
  it.each([null, {}, { name: 'main', commit: {} }])(
    'should reject malformed branch %j',
    async (value) => {
      await expect(
        setup([branch, value]).client.listBranches(target, 1, signal),
      ).rejects.toThrow(/invalid/i);
    },
  );
  it('should encode slash refs and constructs authenticated provider URLs', async () => {
    const s = setup(branch);
    const result = await s.client.readBranch(target, branch.name, signal);
    expect(result.ref.name).toBe(branch.name);
    expect(String(s.fetchFn.mock.calls[0]?.[0])).toBe(
      'https://api.github.com/repos/owner/repo/branches/feature%2Fslash',
    );
    expect(s.beforeAttempt).toHaveBeenCalledOnce();
    expect(s.onAttemptFinished).toHaveBeenCalledOnce();
  });
  it('should preserve separate refs with the same SHA and uses branch page size', async () => {
    const s = setup([branch, { ...branch, name: 'main' }]);
    const result = await s.client.listBranches(target, 1, signal);
    expect(result.items).toHaveLength(2);
    expect(
      new URL(String(s.fetchFn.mock.calls[0]?.[0])).searchParams.get(
        'per_page',
      ),
    ).toBe('100');
    expect(result.hasNext).toBe(false);
  });
  it('should preserve Git identities, offsets and nullable provider identities with bounded SHA queries', async () => {
    const value = commit();
    const s = setup([value, { ...value, author: null }]);
    const result = await s.client.listCommits(target, sha, interval, 1, signal);
    expect(result.items[0]?.author.account?.providerType).toBe('User');
    expect(result.items[0]?.committer.account?.providerType).toBe('Bot');
    expect(result.items[1]?.author.account).toBeNull();
    expect(result.items[0]?.authoredDate).toBe(value.commit.author.date);
    const url = new URL(String(s.fetchFn.mock.calls[0]?.[0]));
    expect(url.searchParams.get('since')).toBe('2025-03-31T23:59:59.000Z');
    expect(url.searchParams.get('until')).toBe('2026-10-06T12:00:01.000Z');
    expect(url.searchParams.get('sha')).toBe(sha);
    expect(url.searchParams.get('per_page')).toBe('30');
  });
  it.each([
    null,
    {},
    { ...commit(), sha: undefined },
    {
      ...commit(),
      commit: { ...commit().commit, author: { date: '2025-02-30T00:00:00Z' } },
    },
  ])('should reject malformed commit items %j', async (value) => {
    await expect(
      setup([commit(), value]).client.listCommits(
        target,
        sha,
        interval,
        1,
        signal,
      ),
    ).rejects.toThrow(/invalid/i);
  });
  it.each([
    'https://evil.test/repos/owner/repo/branches?per_page=100&page=2',
    'https://api.github.com/repos/other/repo/branches?per_page=100&page=2',
    'https://api.github.com/repos/owner/repo/branches?per_page=100&page=1',
    'https://api.github.com/repos/owner/repo/branches?per_page=100&page=3',
    'https://api.github.com/repos/owner/repo/branches?per_page=30&page=2',
  ])('should reject unsafe pagination %s', async (link) => {
    const s = setup([branch], `<${link}>; rel="next"`);
    await expect(s.client.listBranches(target, 1, signal)).rejects.toThrow(
      /pagination/i,
    );
    expect(s.fetchFn).toHaveBeenCalledOnce();
  });
  it('should require a further page when a full body omits next Link and paces the activity lane', async () => {
    const s = setup(Array.from({ length: 100 }, () => branch));
    expect((await s.client.listBranches(target, 1, signal)).hasNext).toBe(true);
    s.fetchFn.mockResolvedValueOnce(new Response('[]'));
    expect((await s.client.listBranches(target, 2, signal)).hasNext).toBe(
      false,
    );
    expect(s.sleep).toHaveBeenCalledWith(1000, signal);
  });
  it('should redact token from raw payloads and normalized facts', async () => {
    const s = setup([{ name: 'SECRET', commit: { sha }, message: 'SECRET' }]);
    expect(
      JSON.stringify(await s.client.listBranches(target, 1, signal)),
    ).not.toContain('SECRET');
  });
  it('should reject unsupported provider timestamp slices before fetching', async () => {
    const s = setup([]);
    await expect(
      s.client.listCommits(
        target,
        sha,
        { ...interval, since: '1969-01-01T00:00:00Z' },
        1,
        signal,
      ),
    ).rejects.toThrow(/range/i);
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it.each([403, 404, 409])(
    'should not treat HTTP %s as absence',
    async (status) => {
      await expect(
        setup({}, undefined, status).client.listBranches(target, 1, signal),
      ).rejects.toThrow();
    },
  );
});
