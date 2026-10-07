import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as immediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';
import { openProtocolStore } from '../src/discovery/storage/protocol-store.js';
import { openStore } from '../src/discovery/storage.js';
import { query } from './helpers.js';
import {
  humanActivityRule,
  syntheticCommit,
  syntheticRepositories,
} from './protocol-helpers.js';

const directories: string[] = [];
const epoch = new Date('2026-10-06T12:00:00Z');
const head = (id: number) => (1000 + id).toString(16).padStart(40, '0');
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'protocol-integration-'));
  directories.push(directory);
  const catalog = join(directory, 'catalog.json');
  const protocol = join(directory, 'protocol.json');
  const output = join(directory, 'run');
  writeFileSync(
    catalog,
    JSON.stringify({ version: 3, queries: [query({ id: 'pilot' })] }),
  );
  writeFileSync(
    protocol,
    JSON.stringify({ version: 1, eligibility: [humanActivityRule()] }),
  );
  return {
    output,
    catalog,
    protocol,
    args: [
      'discover',
      '--queries',
      catalog,
      '--protocol',
      protocol,
      '--output',
      output,
    ],
  };
}
function transport(failIntermediatePage = true) {
  let invocation = 0;
  let pageTwoAttempts = 0;
  const requests: Array<{
    invocation: number;
    url: URL;
    redirect: RequestRedirect | undefined;
  }> = [];
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      requests.push({ invocation, url, redirect: init?.redirect });
      if (url.pathname === '/search/repositories')
        return json({
          total_count: 12,
          incomplete_results: false,
          items: syntheticRepositories(),
        });
      if (url.pathname === '/graphql') {
        const ids: string[] = JSON.parse(String(init?.body)).variables.ids;
        return json({
          data: {
            nodes: ids.map((node) => {
              const id = Number(node.slice(2));
              return {
                databaseId: id,
                nameWithOwner: `pilot/r${id}`,
                defaultBranchRef: {
                  name: 'main',
                  target: { oid: invocation ? 'f'.repeat(40) : head(id) },
                },
              };
            }),
          },
        });
      }
      const match = /^\/repos\/pilot\/r(\d+)\/(branches|commits)$/.exec(
        url.pathname,
      );
      if (!match) throw new Error(`Unexpected endpoint ${url.pathname}`);
      const id = Number(match[1]);
      if (match[2] === 'branches')
        return json(
          id === 3
            ? [{ name: 'dependabot/other', commit: { sha: 'e'.repeat(40) } }]
            : id === 12
              ? [{ name: 'shared', commit: { sha: head(12) } }]
              : [],
        );
      const page = Number(url.searchParams.get('page'));
      if (failIntermediatePage && id === 10 && page === 2) {
        pageTwoAttempts++;
        if (invocation === 0)
          return json({ message: 'intermediate page failed' }, 400);
        if (pageTwoAttempts === 2) return json({ message: 'temporary' }, 503);
      }
      const bot = (seed: number) => syntheticCommit(seed, { author: 'bot' });
      switch (id) {
        case 1:
          return json([syntheticCommit(1)]);
        case 2:
          return json([
            syntheticCommit(2, { committedDate: '2025-03-31T23:59:59Z' }),
          ]);
        case 3:
          return json(
            url.searchParams.get('sha') === head(id)
              ? [bot(3)]
              : url.searchParams.get('sha') === 'e'.repeat(40)
                ? [syntheticCommit(303)]
                : (() => {
                    throw new Error('Unexpected other branch head');
                  })(),
          );
        case 4:
          return json([syntheticCommit(4, { merge: true })]);
        case 5:
          return json(
            page === 1
              ? Array.from({ length: 30 }, (_, n) => bot(500 + n))
              : [bot(530), syntheticCommit(531)],
          );
        case 6:
          return json([
            bot(6),
            syntheticCommit(606, { author: 'conflicting' }),
          ]);
        case 7:
          return json([syntheticCommit(7, { author: 'unknown' })]);
        case 8:
          return json([
            syntheticCommit(8, { committedDate: '2026-10-07T12:00:00Z' }),
          ]);
        case 9:
          return json([
            syntheticCommit(9, {
              sha: head(9),
              committedDate: '2024-01-01T00:00:00Z',
            }),
            syntheticCommit(909),
          ]);
        case 10:
          return json(
            page === 1
              ? Array.from({ length: 30 }, (_, n) => bot(10000 + n))
              : [syntheticCommit(1030)],
          );
        case 11:
          return json([syntheticCommit(11, { sha: 'd'.repeat(40) })]);
        case 12:
          return json([
            syntheticCommit(12, { sha: 'd'.repeat(40), author: 'bot' }),
          ]);
        default:
          throw new Error('Unexpected repository');
      }
    });
  return {
    fetch,
    requests,
    resume: () => {
      invocation++;
    },
  };
}

function singleRepositoryTransport(
  options: { pushedAt?: string; rateLimit?: boolean; interrupt?: boolean } = {},
) {
  const requests: URL[] = [];
  const attemptTimes: number[] = [];
  let activityAttempts = 0;
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      expect(url.hostname).toBe('api.github.com');
      expect(url.pathname).not.toMatch(/\/(pulls|compare|diff)(\/|$)/);
      if (url.pathname === '/search/repositories')
        return json({
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              ...syntheticRepositories()[0],
              pushed_at: options.pushedAt ?? '2025-04-01T00:00:00Z',
            },
          ],
        });
      if (url.pathname === '/graphql')
        return json({
          data: {
            nodes: [
              {
                databaseId: 1,
                nameWithOwner: 'pilot/r1',
                pushedAt: options.pushedAt ?? '2025-04-01T00:00:00Z',
                defaultBranchRef: { name: 'main', target: { oid: head(1) } },
              },
            ],
          },
        });
      if (url.pathname !== '/repos/pilot/r1/commits')
        throw new Error(`Unexpected endpoint ${url.pathname}`);
      expect(init?.redirect).toBe('error');
      activityAttempts++;
      attemptTimes.push(Date.now());
      if (options.rateLimit && activityAttempts === 1)
        return new Response(
          JSON.stringify({ message: 'rate limit exceeded' }),
          {
            status: 403,
            headers: {
              'retry-after': '2',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-resource': 'core',
              'x-ratelimit-used': '5000',
            },
          },
        );
      if (options.interrupt) {
        const signal = init?.signal;
        const pending = new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
        // Send a native signal only after the CLI's listener and HTTP abort listener exist.
        process.kill(process.pid, 'SIGINT');
        await immediate();
        return pending;
      }
      return json([syntheticCommit(1)]);
    });
  return { fetch, requests, attemptTimes };
}

async function run(args: string[]) {
  const running = main(args, { GITHUB_TOKEN: 'synthetic-token' });
  await vi.runAllTimersAsync();
  return running;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe('controlled protocol integration (mock transport, not live GitHub since validation)', () => {
  it('retains 12 repository scenarios, resumes immutable page checkpoints, and exports offline', async () => {
    const f = fixture();
    const http = transport();
    expect(await run([...f.args, '--activity-max-requests', '3'])).toBe(2);
    let store = openProtocolStore(join(f.output, 'discovery.sqlite'));
    const candidates = [...store.iterateCandidates()];
    expect(candidates).toHaveLength(12);
    expect(candidates.map((candidate) => candidate.evaluation?.status)).toEqual(
      [
        'pass',
        'fail',
        'pass',
        'pass',
        'pass',
        'fail',
        'unknown',
        'fail',
        'pass',
        'unknown',
        'pass',
        'fail',
      ],
    );
    const failedTask = store
      .readTasks()
      .find(
        (task) =>
          task.repositoryId === 10 && task.request.kind === 'commit_history',
      );
    expect(failedTask?.state).toBe('failed');
    expect(failedTask?.checkpoint?.defaultRef).toMatchObject({
      ref: { headSha: head(10) },
      nextPage: 2,
      complete: false,
    });
    const retained = store.readCandidateFacts(10);
    expect(retained.commits).toHaveLength(30);
    expect(retained.coverage[0]?.pages).toBe(1);
    const stable = candidates
      .filter((candidate) => candidate.id !== 10)
      .map((candidate) => store.readCandidateFacts(candidate.id));
    const initial = store.getRun().invocations[0]?.id;
    const summary = store.readCollectionSummary();
    expect(
      summary.perCandidate.every(
        (candidate) =>
          candidate.invocationId === initial &&
          candidate.activity.attempts <= 3,
      ),
    ).toBe(true);
    expect(
      summary.perCandidate.find((candidate) => candidate.repositoryId === 10)
        ?.activity.attempts,
    ).toBe(2);
    expect(store.readCandidateFacts(5).commits).toHaveLength(32);
    expect(store.readCandidateFacts(7).coverage[0]?.state).toBe('complete');
    expect(
      candidates.find((candidate) => candidate.id === 7)?.evaluation?.rules[0]
        ?.reason,
    ).toBe('author_indeterminate');
    expect(
      store
        .readCandidateFacts(3)
        .commits.find((commit) => commit.author.account?.login === 'person')
        ?.refs?.[0]?.name,
    ).toBe('dependabot/other');
    expect(store.readCandidateFacts(4).commits[0]).toMatchObject({
      author: { account: { providerType: 'User' } },
      committer: { account: { providerType: 'Bot' } },
    });
    expect(store.readCandidateFacts(11).commits[0]?.sha).toBe(
      store.readCandidateFacts(12).commits[0]?.sha,
    );
    expect(
      store.readCandidateFacts(11).commits[0]?.author.account?.providerType,
    ).toBe('User');
    expect(
      store.readCandidateFacts(12).commits[0]?.author.account?.providerType,
    ).toBe('Bot');
    expect(store.readCandidateFacts(12).commits).toHaveLength(1);
    expect(
      store
        .readCandidateFacts(12)
        .commits[0]?.refs?.map((ref) => ref.name)
        .sort(),
    ).toEqual(['main', 'shared']);
    const branchThree = http.requests.filter(({ url }) =>
      url.pathname.startsWith('/repos/pilot/r3/'),
    );
    expect(
      branchThree.map(({ url }) => [url.pathname, url.searchParams.get('sha')]),
    ).toEqual([
      ['/repos/pilot/r3/commits', head(3)],
      ['/repos/pilot/r3/branches', null],
      ['/repos/pilot/r3/commits', 'e'.repeat(40)],
    ]);
    for (const candidate of candidates.filter(
      (candidate) => candidate.evaluation?.status === 'pass',
    ))
      expect(
        candidate.evaluation?.rules[0]?.evidenceIds.length,
      ).toBeGreaterThan(0);
    store.close();

    http.resume();
    expect(
      await run([
        'discover',
        '--resume',
        f.output,
        '--activity-max-requests',
        '2',
      ]),
    ).toBe(0);
    store = openProtocolStore(join(f.output, 'discovery.sqlite'));
    expect(store.getRun().state).toBe('complete');
    expect(store.getRun().invocations).toHaveLength(2);
    const resumed = store.readCandidateFacts(10);
    expect(resumed.commits).toEqual(expect.arrayContaining(retained.commits));
    expect(resumed.commits).toHaveLength(31);
    expect(resumed.inspectionUntil).toBe(retained.inspectionUntil);
    const persisted = new DatabaseSync(join(f.output, 'discovery.sqlite'), {
      readOnly: true,
    });
    expect(
      persisted
        .prepare(
          'SELECT COUNT(*) AS pages FROM collection_pages WHERE task_id = ?',
        )
        .get(failedTask?.id ?? '')?.pages,
    ).toBe(2);
    persisted.close();
    expect(
      store.readTasks().find((task) => task.id === failedTask?.id)?.checkpoint
        ?.defaultRef,
    ).toMatchObject({
      ref: { headSha: head(10) },
      complete: true,
      nextPage: null,
    });
    expect(
      [...store.iterateCandidates()].find((candidate) => candidate.id === 10)
        ?.evaluation?.status,
    ).toBe('pass');
    expect(
      stable.map((facts) => store.readCandidateFacts(facts.candidate.id)),
    ).toEqual(stable);
    const currentSummary = store.readCollectionSummary();
    expect(currentSummary.metadata.attempts).toBe(summary.metadata.attempts);
    const second = currentSummary.perCandidate.filter(
      (candidate) => candidate.invocationId !== initial,
    );
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      repositoryId: 10,
      activity: { attempts: 2, retries: 1 },
    });
    expect(currentSummary.activity.attempts).toBe(
      summary.activity.attempts + 2,
    );
    const finalFacts = [...store.iterateCandidates()].map((candidate) =>
      store.readCandidateFacts(candidate.id),
    );
    store.close();
    const resumedRequests = http.requests.filter(
      (request) => request.invocation === 1,
    );
    expect(resumedRequests).toHaveLength(2);
    expect(
      resumedRequests.every(
        ({ url }) =>
          url.pathname === '/repos/pilot/r10/commits' &&
          url.searchParams.get('sha') === head(10) &&
          url.searchParams.get('page') === '2',
      ),
    ).toBe(true);
    expect(
      http.requests.every(({ url }) => url.hostname === 'api.github.com'),
    ).toBe(true);
    expect(
      http.requests.some(({ url }) =>
        /\/(pulls|compare|diff)(\/|$)/.test(url.pathname),
      ),
    ).toBe(false);
    expect(
      http.requests
        .filter(({ url }) => url.pathname.startsWith('/repos/'))
        .every(({ redirect }) => redirect === 'error'),
    ).toBe(true);
    expect(
      http.requests
        .filter(({ url }) => url.pathname.endsWith('/commits'))
        .every(
          ({ url }) =>
            url.searchParams.get('per_page') === '30' &&
            url.searchParams.get('since') === '2025-03-31T23:59:59.000Z',
        ),
    ).toBe(true);
    const before = [
      'candidates.csv',
      'discovery-hits.csv',
      'coverage.json',
      'manifest.json',
      'report.md',
    ].map((name) => readFileSync(join(f.output, name), 'utf8'));
    http.fetch.mockClear();
    expect(await main(['report', '--run', f.output], {})).toBe(0);
    expect(http.fetch).not.toHaveBeenCalled();
    expect(
      [
        'candidates.csv',
        'discovery-hits.csv',
        'coverage.json',
        'manifest.json',
        'report.md',
      ].map((name) => readFileSync(join(f.output, name), 'utf8')),
    ).toEqual(before);
    expect(
      await run([
        'discover',
        '--resume',
        f.output,
        '--activity-max-requests',
        '2',
      ]),
    ).toBe(0);
    expect(http.fetch).not.toHaveBeenCalled();
    store = openProtocolStore(join(f.output, 'discovery.sqlite'));
    expect(
      [...store.iterateCandidates()].map((candidate) =>
        store.readCandidateFacts(candidate.id),
      ),
    ).toEqual(finalFacts);
    store.close();
  });
  it('enforces actual invocation ceilings and matches uninterrupted data and evaluations after resume', async () => {
    const limited = fixture();
    const http = transport(false);
    expect(await run([...limited.args, '--activity-max-requests', '1'])).toBe(
      2,
    );
    let store = openProtocolStore(join(limited.output, 'discovery.sqlite'));
    expect(
      store
        .readCollectionSummary()
        .perCandidate.every((candidate) => candidate.activity.attempts <= 1),
    ).toBe(true);
    expect(
      store
        .readTasks()
        .filter((task) => task.state === 'limited')
        .map((task) => task.repositoryId),
    ).toEqual([2, 3, 5, 6, 7, 8, 10, 12]);
    const saved = store.readCandidateFacts(5).commits;
    const inspectionUntil = store.readCandidateFacts(5).inspectionUntil;
    store.close();
    http.resume();
    expect(
      await run([
        'discover',
        '--resume',
        limited.output,
        '--activity-max-requests',
        '3',
      ]),
    ).toBe(0);
    store = openProtocolStore(join(limited.output, 'discovery.sqlite'));
    const summary = store.readCollectionSummary();
    expect(
      summary.invocations.map(
        (invocation) => invocation.limits.maxActivityRequestsPerCandidate,
      ),
    ).toEqual([1, 3]);
    expect(
      summary.perCandidate.every(
        (candidate) =>
          candidate.activity.attempts <=
          (candidate.invocationId === summary.invocations[0]?.id ? 1 : 3),
      ),
    ).toBe(true);
    expect(store.readCandidateFacts(5).commits).toEqual(
      expect.arrayContaining(saved),
    );
    expect(store.readCandidateFacts(5).inspectionUntil).toBe(inspectionUntil);
    // Collection timestamps/revisions reflect execution timing; domain facts and evidence must agree.
    const semanticSnapshot = (output: string) => {
      const snapshot = openProtocolStore(join(output, 'discovery.sqlite'));
      const db = new DatabaseSync(join(output, 'discovery.sqlite'), {
        readOnly: true,
      });
      const evidence = (id: string) => {
        if (!id.startsWith('page:')) return id;
        const row = db
          .prepare('SELECT data_json FROM collection_pages WHERE id = ?')
          .get(id.slice(5));
        expect(row).toBeDefined();
        const page = JSON.parse(String(row?.data_json)) as {
          requestUrl: string;
          raw: unknown;
        };
        return JSON.stringify({ requestUrl: page.requestUrl, raw: page.raw });
      };
      try {
        return [...snapshot.iterateCandidates()].map((candidate) => {
          const facts = snapshot.readCandidateFacts(candidate.id);
          return {
            id: candidate.id,
            evaluation: candidate.evaluation && {
              ...candidate.evaluation,
              rules: candidate.evaluation.rules.map((rule) => ({
                ...rule,
                evidenceIds: rule.evidenceIds.map(evidence).sort(),
              })),
            },
            inspectionUntil: facts.inspectionUntil,
            commits: facts.commits.map(
              ({ observedAt: _observedAt, refs, ...commit }) => ({
                ...commit,
                refs: refs?.map(
                  ({ observedAt: _refObservedAt, ...ref }) => ref,
                ),
              }),
            ),
          };
        });
      } finally {
        db.close();
        snapshot.close();
      }
    };
    store.close();
    const resumed = semanticSnapshot(limited.output);
    http.fetch.mockRestore();
    vi.setSystemTime(epoch);
    const uninterrupted = fixture();
    const clean = transport(false);
    expect(
      await run([...uninterrupted.args, '--activity-max-requests', '3']),
    ).toBe(0);
    expect(semanticSnapshot(uninterrupted.output)).toEqual(resumed);
    for (const request of [...http.requests, ...clean.requests]) {
      expect(request.url.hostname).toBe('api.github.com');
      expect(request.url.pathname).not.toMatch(/\/(pulls|compare|diff)(\/|$)/);
    }
  });
  it('no protocol creates no temporal query filter or activity work and reports offline', async () => {
    const f = fixture();
    const http = singleRepositoryTransport();
    const args = f.args.filter(
      (value, index, all) =>
        value !== '--protocol' && all[index - 1] !== '--protocol',
    );
    expect(await run(args)).toBe(0);
    expect(http.requests.map((url) => url.pathname)).toEqual([
      '/search/repositories',
    ]);
    expect(http.requests[0]?.searchParams.get('q')).not.toMatch(
      /pushed:|committer-date:|author-date:/,
    );
    const store = openProtocolStore(join(f.output, 'discovery.sqlite'));
    expect([...store.iterateCandidates()][0]?.evaluation?.status).toBe(
      'not_applied',
    );
    expect(store.readTasks()).toEqual([]);
    expect(store.readCandidateFacts(1).commits).toEqual([]);
    store.close();
    http.fetch.mockClear();
    expect(await main(['report', '--run', f.output], {})).toBe(0);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['2025-04-01T00:00:00Z', 'pass'],
    ['2025-03-31T23:59:59Z', 'fail'],
  ])(
    'last_push evaluates %s as %s without commit collection',
    async (pushedAt, status) => {
      const f = fixture();
      writeFileSync(
        f.protocol,
        JSON.stringify({
          version: 1,
          eligibility: [{ id: 'push', type: 'last_push', since: '2025-04-01' }],
        }),
      );
      const http = singleRepositoryTransport({ pushedAt });
      expect(await run(f.args)).toBe(0);
      expect(
        http.requests.every((url) => !url.pathname.startsWith('/repos/')),
      ).toBe(true);
      const store = openProtocolStore(join(f.output, 'discovery.sqlite'));
      expect([...store.iterateCandidates()][0]?.evaluation).toMatchObject({
        status,
        rules: [{ ruleId: 'push', status }],
      });
      expect(store.readCandidateFacts(1).commits).toEqual([]);
      store.close();
      http.fetch.mockClear();
      expect(await main(['report', '--run', f.output], {})).toBe(0);
      expect(http.fetch).not.toHaveBeenCalled();
    },
  );

  it('schema-v2 catalog retains legacy temporal scope, exports and resume without activity', async () => {
    const f = fixture();
    writeFileSync(
      f.catalog,
      JSON.stringify({
        version: 2,
        filters: { pushedSince: '2025-04-01' },
        queries: [query({ id: 'pilot' })],
      }),
    );
    const http = singleRepositoryTransport({
      pushedAt: '2025-03-31T23:59:59Z',
    });
    const args = f.args.filter(
      (value, index, all) =>
        value !== '--protocol' && all[index - 1] !== '--protocol',
    );
    expect(await run(args)).toBe(0);
    expect(http.requests[0]?.searchParams.get('q')).toContain(
      'pushed:>=2025-04-01',
    );
    expect(
      http.requests.every((url) => !url.pathname.startsWith('/repos/')),
    ).toBe(true);
    const store = openStore(join(f.output, 'discovery.sqlite'));
    expect(store.getCatalog().version).toBe(2);
    expect([...store.iterateCandidates()]).toHaveLength(1);
    store.close();
    const db = new DatabaseSync(join(f.output, 'discovery.sqlite'), {
      readOnly: true,
    });
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE name='activity_commits'",
        )
        .get()?.count,
    ).toBe(0);
    db.close();
    const csv = readFileSync(join(f.output, 'candidates.csv'), 'utf8');
    expect(csv).toContain('out_of_scope_temporal');
    const outputs = [
      'candidates.csv',
      'discovery-hits.csv',
      'coverage.json',
      'manifest.json',
      'report.md',
    ].map((name) => readFileSync(join(f.output, name), 'utf8'));
    http.fetch.mockClear();
    expect(await main(['report', '--run', f.output], {})).toBe(0);
    expect(await run(['discover', '--resume', f.output])).toBe(0);
    expect(http.fetch).not.toHaveBeenCalled();
    expect(
      [
        'candidates.csv',
        'discovery-hits.csv',
        'coverage.json',
        'manifest.json',
        'report.md',
      ].map((name) => readFileSync(join(f.output, name), 'utf8')),
    ).toEqual(outputs);
  });

  it('real HTTP rate-limit handling waits, retries and persists telemetry under the invocation budget', async () => {
    const f = fixture();
    const http = singleRepositoryTransport({ rateLimit: true });
    expect(await run([...f.args, '--activity-max-requests', '2'])).toBe(0);
    expect(http.attemptTimes).toHaveLength(2);
    expect(
      (http.attemptTimes[1] ?? 0) - (http.attemptTimes[0] ?? 0),
    ).toBeGreaterThanOrEqual(2000);
    const store = openProtocolStore(join(f.output, 'discovery.sqlite'));
    expect(store.readCollectionSummary().activity).toMatchObject({
      attempts: 2,
      retries: 1,
      waitMs: 2000,
    });
    expect(store.readCollectionSummary().perCandidate[0]?.invocationId).toBe(
      store.getRun().invocations[0]?.id,
    );
    expect([...store.iterateCandidates()][0]?.evaluation?.status).toBe('pass');
    store.close();
    const db = new DatabaseSync(join(f.output, 'discovery.sqlite'), {
      readOnly: true,
    });
    const events = db
      .prepare(
        "SELECT event_json FROM collection_attempts WHERE kind='activity' ORDER BY id",
      )
      .all()
      .map((row) => JSON.parse(String(row.event_json)));
    expect(events[0]).toMatchObject({
      status: 403,
      rateLimitResource: 'core',
      rateLimitUsed: 5000,
      attempt: 1,
    });
    expect(events[1]).toMatchObject({ status: 200, attempt: 2, waitMs: 2000 });
    db.close();
  });

  it('native SIGINT aborts pending HTTP, persists partial state and resumes without repeating completed search', async () => {
    const f = fixture();
    const listeners = process.listenerCount('SIGINT');
    const http = singleRepositoryTransport({ interrupt: true });
    // No fake-clock advancement while the native signal is pending.
    expect(await main(f.args, { GITHUB_TOKEN: 'synthetic-token' })).toBe(2);
    expect(process.listenerCount('SIGINT')).toBe(listeners);
    let store = openProtocolStore(join(f.output, 'discovery.sqlite'));
    expect(store.getRun().state).toBe('partial');
    expect(store.readCollectionSummary().activity.attempts).toBe(1);
    expect([...store.iterateCandidates()][0]?.evaluation?.status).toBe(
      'unknown',
    );
    expect(
      store
        .readTasks()
        .some(
          (task) =>
            task.request.kind === 'commit_history' && task.state === 'pending',
        ),
    ).toBe(true);
    const telemetry = new DatabaseSync(join(f.output, 'discovery.sqlite'), {
      readOnly: true,
    });
    const event = JSON.parse(
      String(
        telemetry
          .prepare(
            "SELECT event_json FROM collection_attempts WHERE kind='activity'",
          )
          .get()?.event_json,
      ),
    );
    expect(event.error).toContain('SIGINT');
    telemetry.close();
    const until = store.readCandidateFacts(1).inspectionUntil;
    store.close();
    expect(readFileSync(join(f.output, 'report.md'), 'utf8')).toContain(
      'partial',
    );
    http.fetch.mockRestore();
    const resumed = singleRepositoryTransport();
    expect(await run(['discover', '--resume', f.output])).toBe(0);
    expect(resumed.requests.map((url) => url.pathname)).toEqual([
      '/repos/pilot/r1/commits',
    ]);
    store = openProtocolStore(join(f.output, 'discovery.sqlite'));
    expect(store.getRun().state).toBe('complete');
    expect(store.getRun().invocations).toHaveLength(2);
    expect(store.readCandidateFacts(1).inspectionUntil).toBe(until);
    expect(store.readCollectionSummary().activity.attempts).toBe(2);
    expect([...store.iterateCandidates()][0]?.evaluation?.status).toBe('pass');
    store.close();
  });
});
