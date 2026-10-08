import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { humanActivityRule, query, restCommitPayload } from '@tests/helpers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '@/cli/main.js';
import { openStore } from '@/modules/discovery/storage/store.js';

const env = { GITHUB_TOKEN: 'fake-token' };
const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'protocol-cli-'));
  directories.push(directory);
  const queries = join(directory, 'catalog.json');
  const protocol = join(directory, 'protocol.json');
  const output = join(directory, 'run');
  writeFileSync(
    queries,
    JSON.stringify({
      queries: [query({ id: 'q' })],
    }),
  );
  writeFileSync(
    protocol,
    JSON.stringify({ eligibility: [humanActivityRule()] }),
  );
  return {
    directory,
    queries,
    protocol,
    output,
    args: ['discover', '--queries', queries, '--output', output],
  };
}
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status });
function mockGitHub(
  options: { unknown?: boolean; retry?: boolean; saturated?: boolean } = {},
) {
  let activity = 0;
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/graphql') {
        const ids: string[] = JSON.parse(String(init?.body)).variables.ids;
        return json({
          data: {
            nodes: ids.map((id) => ({
              databaseId: Number(id.slice(2)),
              nameWithOwner: `org/r${id.slice(2)}`,
              defaultBranchRef: {
                name: 'main',
                target: { oid: 'a'.repeat(40) },
              },
            })),
          },
        });
      }
      if (url.pathname.includes('/search/'))
        return json({
          total_count: options.saturated ? 1500 : 2,
          incomplete_results: false,
          items: [1, 2].map((id) => ({
            id,
            node_id: `R_${id}`,
            full_name: `org/r${id}`,
            html_url: `https://github.com/org/r${id}`,
          })),
        });
      if (url.pathname.endsWith('/branches')) return json([]);
      activity++;
      if (options.retry && activity === 1)
        return json({ message: 'temporary' }, 503);
      const payload = restCommitPayload();
      if (options.unknown) {
        payload.author = null as unknown as typeof payload.author;
        payload.commit.author.name = '';
      }
      return json([payload]);
    });
}
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe('protocol CLI', () => {
  it('should collect nothing and report offline for a run without a protocol', async () => {
    const f = fixture();
    const fetch = mockGitHub();
    expect(await main(f.args, env)).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockClear();
    expect(await main(['report', '--run', f.output], {})).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(readdirSync(f.output)).toEqual(
      expect.arrayContaining([
        'candidates.csv',
        'discovery-hits.csv',
        'coverage.json',
        'report.md',
        'manifest.json',
      ]),
    );
    const store = openStore(join(f.output, 'discovery.sqlite'));
    expect([...store.iterateCandidates()][0]?.evaluation?.status).toBe(
      'not_applied',
    );
    store.close();
  });
  it('should count one global attempt for two targets with the real metadata factory and carry oid in the query', async () => {
    const f = fixture();
    const fetch = mockGitHub();
    expect(await main([...f.args, '--protocol', f.protocol], env)).toBe(0);
    const store = openStore(join(f.output, 'discovery.sqlite'));
    const summary = store.readCollectionSummary();
    expect(summary.metadata.attempts).toBe(1);
    expect(summary.activity.attempts).toBe(2);
    expect(
      summary.perCandidate.every(
        (c) => c.invocationId === store.getRun().invocations[0]?.id,
      ),
    ).toBe(true);
    expect(
      fetch.mock.calls.find(([url]) => String(url).endsWith('/graphql'))?.[1]
        ?.body,
    ).toContain('target { oid }');
    store.close();
  });
  it('should complete a run whose only unknown is a terminal author', async () => {
    const f = fixture();
    mockGitHub({ unknown: true });
    expect(await main([...f.args, '--protocol', f.protocol], env)).toBe(0);
    const store = openStore(join(f.output, 'discovery.sqlite'));
    expect([...store.iterateCandidates()][0]?.evaluation?.status).toBe(
      'unknown',
    );
    expect(store.getRun().state).toBe('complete');
    store.close();
  });
  it('should consume the per-invocation budget on activity retries and give a resume a fresh invocation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetch = mockGitHub({ retry: true });
    const running = main(
      [...f.args, '--protocol', f.protocol, '--activity-max-requests', '1'],
      env,
    );
    await vi.runAllTimersAsync();
    expect(await running).toBe(2);
    let store = openStore(join(f.output, 'discovery.sqlite'));
    expect(store.readCollectionSummary().activity.attempts).toBe(2);
    const initial = store.getRun().invocations[0]?.id;
    store.close();
    fetch.mockClear();
    const resumed = main(
      ['discover', '--resume', f.output, '--activity-max-requests', '2'],
      env,
    );
    await vi.runAllTimersAsync();
    expect(await resumed).toBe(0);
    store = openStore(join(f.output, 'discovery.sqlite'));
    expect(store.getRun().invocations).toHaveLength(2);
    expect(store.getRun().invocations[1]?.id).not.toBe(initial);
    expect(store.readCollectionSummary().metadata.attempts).toBe(1);
    store.close();
  });
  it('should announce the pending work on stderr before the first request of a resume', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetch = mockGitHub({ retry: true });
    const running = main(
      [...f.args, '--protocol', f.protocol, '--activity-max-requests', '1'],
      env,
    );
    await vi.runAllTimersAsync();
    expect(await running).toBe(2);
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Retomando'),
    );
    const store = openStore(join(f.output, 'discovery.sqlite'));
    const subqueries = store
      .readCoverage()
      .filter((c) => c.state === 'pending' || c.state === 'failed').length;
    const tasks = store
      .readTasks()
      .filter((t) => ['pending', 'failed', 'limited'].includes(t.state)).length;
    store.close();
    expect(tasks).toBeGreaterThan(0);
    fetch.mockClear();
    vi.mocked(console.error).mockClear();

    const resumed = main(['discover', '--resume', f.output], env);
    await vi.runAllTimersAsync();
    await resumed;

    const announcement = `Retomando: ${subqueries} subconsultas e ${tasks} tarefas pendentes.`;
    expect(console.error).toHaveBeenCalledWith(announcement);
    const announced = vi
      .mocked(console.error)
      .mock.invocationCallOrder.at(0) as number;
    expect(fetch.mock.invocationCallOrder[0]).toBeGreaterThan(announced);
  });
  it.each(['0', '-1', '1.2', 'NaN', 'Infinity'])(
    'should reject invalid budgets %s before creating output or HTTP',
    async (value) => {
      const f = fixture();
      const fetch = vi.spyOn(globalThis, 'fetch');
      expect(
        await main([...f.args, '--activity-max-requests', value], env),
      ).toBe(1);
      expect(existsSync(f.output)).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('should reject oversized pages, invalid protocols and explicit dry-run budgets', async () => {
    const f = fixture();
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const args of [
      [...f.args, '--activity-commits-per-page', '101'],
      [...f.args, '--activity-branches-per-page', '101'],
      [
        'discover',
        '--queries',
        f.queries,
        '--dry-run',
        '--activity-max-requests',
        '20',
      ],
    ])
      expect(await main(args, env)).toBe(1);
    writeFileSync(f.protocol, '{"eligibility":[{}]}');
    expect(await main([...f.args, '--protocol', f.protocol], env)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(f.output)).toBe(false);
  });
  it('should accept policy dry-run without collection and reports saturation as 2', async () => {
    const f = fixture();
    const fetch = mockGitHub({ saturated: true });
    expect(
      await main(
        [
          'discover',
          '--queries',
          f.queries,
          '--protocol',
          f.protocol,
          '--dry-run',
        ],
        env,
      ),
    ).toBe(2);
    expect(fetch).toHaveBeenCalledOnce();
    expect(existsSync(f.output)).toBe(false);
  });
  it('should reject replacement and malformed stored resume config before HTTP or database writes', async () => {
    const f = fixture();
    const fetch = mockGitHub();
    expect(await main(f.args, env)).toBe(0);
    fetch.mockClear();
    const path = join(f.output, 'discovery.sqlite');
    const before = readFileSync(path);
    for (const replacement of ['--queries', '--protocol'])
      expect(
        await main(
          ['discover', '--resume', f.output, replacement, f.protocol],
          env,
        ),
      ).toBe(1);
    expect(readFileSync(path)).toEqual(before);
    const db = new DatabaseSync(path);
    db.prepare('UPDATE runs SET config_json = ?').run(
      JSON.stringify({
        catalog: { queries: [] },
        protocol: { eligibility: [] },
      }),
    );
    db.close();
    const malformed = readFileSync(path);
    expect(await main(['discover', '--resume', f.output], env)).toBe(1);
    expect(readFileSync(path)).toEqual(malformed);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('should reject activity flags on a resume without eligibility rules before reading stored limits', async () => {
    const f = fixture();
    mockGitHub();
    expect(await main(f.args, env)).toBe(0);
    const path = join(f.output, 'discovery.sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = OFF; DELETE FROM invocations');
    db.close();
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockClear();
    vi.mocked(console.error).mockClear();
    expect(
      await main(
        ['discover', '--resume', f.output, '--activity-max-requests', '2'],
        env,
      ),
    ).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      'Activity options require a protocol with eligibility rules.',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('should reject a resume whose database has no original invocation', async () => {
    const f = fixture();
    mockGitHub();
    expect(await main(f.args, env)).toBe(0);
    const path = join(f.output, 'discovery.sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = OFF; DELETE FROM invocations');
    db.close();
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockClear();
    vi.mocked(console.error).mockClear();
    expect(await main(['discover', '--resume', f.output], env)).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      'Missing original collection limits.',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('should reject a resume that changes the original commits page size', async () => {
    const f = fixture();
    mockGitHub();
    expect(await main([...f.args, '--protocol', f.protocol], env)).toBe(0);
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockClear();
    vi.mocked(console.error).mockClear();
    expect(
      await main(
        ['discover', '--resume', f.output, '--activity-commits-per-page', '50'],
        env,
      ),
    ).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      'Resume must preserve the original commitsPerPage (30).',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    JSON.stringify({
      catalog: { queries: [] },
      protocol: { eligibility: [] },
    }),
    '{unparsable',
  ])(
    'should reject malformed stored report policy without changing database or outputs: %s',
    async (configJson) => {
      const f = fixture();
      const fetch = mockGitHub();
      expect(await main(f.args, env)).toBe(0);
      fetch.mockClear();
      const path = join(f.output, 'discovery.sqlite');
      const db = new DatabaseSync(path);
      db.prepare('UPDATE runs SET config_json = ?').run(configJson);
      db.close();
      const outputs = readdirSync(f.output).filter(
        (name) => name !== 'discovery.sqlite',
      );
      expect(outputs.length).toBeGreaterThan(0);
      for (const name of outputs)
        writeFileSync(join(f.output, name), `sentinel:${name}`);
      const before = readFileSync(path);
      expect(await main(['report', '--run', f.output], {})).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(readFileSync(path)).toEqual(before);
      for (const name of outputs)
        expect(readFileSync(join(f.output, name), 'utf8')).toBe(
          `sentinel:${name}`,
        );
    },
  );
  it('should attribute metadata to a fresh invocation after a hard-crash resume and preserve the stored policy', async () => {
    const f = fixture();
    mockGitHub();
    expect(await main(f.args, env)).toBe(0);
    const path = join(f.output, 'discovery.sqlite');
    const db = new DatabaseSync(path);
    db.prepare("UPDATE runs SET state = 'running', ended_at = NULL").run();
    const stored = db
      .prepare('SELECT config_json FROM runs')
      .get()?.config_json;
    const config = JSON.parse(String(stored));
    config.protocol.eligibility = [humanActivityRule()];
    db.prepare('UPDATE runs SET config_json = ?').run(JSON.stringify(config));
    db.close();
    const store = openStore(path);
    const initial = store.getRun().invocations[0]?.id;
    store.close();
    expect(await main(['discover', '--resume', f.output], env)).toBe(0);
    const resumed = openStore(path);
    expect(resumed.getRun().invocations).toHaveLength(2);
    const active = resumed.getRun().invocations[1]?.id;
    expect(active).not.toBe(initial);
    expect(
      resumed
        .readCollectionSummary()
        .perCandidate.every((c) => c.invocationId === active),
    ).toBe(true);
    expect(resumed.getStudyConfig().protocol).toEqual(config.protocol);
    resumed.close();
  });
  it.each([
    'CREATE TABLE runs (id TEXT PRIMARY KEY)',
    'CREATE TABLE runs (id TEXT PRIMARY KEY); CREATE TABLE enrichments (id INTEGER)',
  ])(
    'should reject an incompatible database without network or writes: %s',
    async (ddl) => {
      const f = fixture();
      mockGitHub();
      expect(await main(f.args, env)).toBe(0);
      const path = join(f.output, 'discovery.sqlite');
      rmSync(path);
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      const db = new DatabaseSync(path);
      db.exec(ddl);
      db.close();
      const hash = () =>
        createHash('sha256').update(readFileSync(path)).digest('hex');
      const before = hash();
      const fetch = vi.mocked(globalThis.fetch);
      fetch.mockClear();
      vi.mocked(console.error).mockClear();
      expect(await main(['discover', '--resume', f.output], env)).toBe(1);
      expect(await main(['report', '--run', f.output], {})).toBe(1);
      const messages = vi
        .mocked(console.error)
        .mock.calls.map(([message]) => String(message));
      expect(messages).toHaveLength(2);
      for (const message of messages)
        expect(message).toMatch(/incompatible format.*new run/);
      expect(hash()).toBe(before);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('should attribute every activity attempt of real transport retries to the active invocation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetch = mockGitHub({ retry: true });
    const running = main(
      [...f.args, '--protocol', f.protocol, '--activity-max-requests', '2'],
      env,
    );
    await vi.runAllTimersAsync();
    expect(await running).toBe(0);
    const store = openStore(join(f.output, 'discovery.sqlite'));
    expect(store.readCollectionSummary().activity.attempts).toBe(3);
    expect(
      store
        .readCollectionSummary()
        .perCandidate.every(
          (c) => c.invocationId === store.getRun().invocations[0]?.id,
        ),
    ).toBe(true);
    expect(
      fetch.mock.calls.filter(([url]) => String(url).includes('/commits')),
    ).toHaveLength(3);
    store.close();
    fetch.mockClear();
    expect(await main(['report', '--run', f.output], {})).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('should count metadata retries once per batch globally rather than once per target', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetch = mockGitHub();
    const original = fetch.getMockImplementation();
    let metadata = 0;
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/graphql') && ++metadata === 1)
        return json({ message: 'temporary' }, 503);
      if (!original) throw new Error('Missing fixture');
      return original(input, init);
    });
    const running = main([...f.args, '--protocol', f.protocol], env);
    await vi.runAllTimersAsync();
    expect(await running).toBe(0);
    const store = openStore(join(f.output, 'discovery.sqlite'));
    expect(store.readCollectionSummary().metadata.attempts).toBe(2);
    expect(
      store
        .readCollectionSummary()
        .perCandidate.every(
          (c) => c.invocationId === store.getRun().invocations[0]?.id,
        ),
    ).toBe(true);
    store.close();
  });
  it('should return 2 and export partial results on saturation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    mockGitHub({ saturated: true });
    const running = main(f.args, env);
    await vi.runAllTimersAsync();
    expect(await running).toBe(2);
    expect(existsSync(join(f.output, 'report.md'))).toBe(true);
  });
});
describe('discovery CLI without a protocol', () => {
  const codeQuery = query({
    id: 'code',
    strategy: 'technology',
    endpoint: 'code',
    q: 'single-spa filename:package.json',
  });
  function workspace(queries = [query({ id: 'q', q: 'microfrontend' })]) {
    const f = fixture();
    writeFileSync(f.queries, JSON.stringify({ queries }));
    return f;
  }
  function searchMock(
    options: { codeFailsFirst?: boolean; totalCount?: number } = {},
  ) {
    const requested: string[] = [];
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        const endpoint = url.pathname.split('/').at(-1);
        requested.push(
          `${endpoint}:${url.searchParams.get('per_page')}:${url.searchParams.get('q')}`,
        );
        if (endpoint === 'repositories')
          return json({
            total_count: options.totalCount ?? 1,
            incomplete_results: false,
            items: [
              {
                id: 91,
                node_id: 'R_91',
                full_name: 'org/r91',
                html_url: 'https://github.com/org/r91',
                pushed_at: '2025-01-01T00:00:00Z',
              },
            ],
          });
        if (
          options.codeFailsFirst &&
          requested.filter((r) => r.startsWith('code')).length === 1
        )
          return json({ message: 'Validation Failed' }, 422);
        return json({
          total_count: options.totalCount ?? 1,
          incomplete_results: false,
          items: [
            {
              path: 'package.json',
              html_url: 'https://github.com/org/r92/blob/main/package.json',
              repository: {
                id: 92,
                node_id: 'R_92',
                full_name: 'org/r92',
                html_url: 'https://github.com/org/r92',
              },
            },
          ],
        });
      });
    return { fetch, requested };
  }

  it('should show help without a token or network access', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await main(['discover', '--help'], {})).toBe(0);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('--dry-run'),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should require a token before creating a run', async () => {
    const f = workspace();
    expect(await main(f.args, {})).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/GITHUB_TOKEN/),
    );
    expect(existsSync(join(f.output, 'discovery.sqlite'))).toBe(false);
  });

  it('should reject --dry-run combined with --output or --resume', async () => {
    const f = workspace();
    expect(await main([...f.args, '--dry-run'], env)).toBe(1);
    expect(
      await main(['discover', '--resume', f.output, '--dry-run'], env),
    ).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/--dry-run/),
    );
  });

  it('should print subquery totals in a dry run without creating files', async () => {
    const f = workspace([
      query({
        id: 'p',
        q: 'microfrontend',
        partition: { by: 'created', from: '2030-01-01', interval: 'year' },
      }),
    ]);
    const before = readdirSync(f.directory).sort();
    const { requested } = searchMock({ totalCount: 1500 });
    expect(
      await main(['discover', '--queries', f.queries, '--dry-run'], env),
    ).toBe(2);
    const output = vi
      .mocked(console.log)
      .mock.calls.map(([line]) => String(line))
      .join('\n');
    expect(requested[0]).toMatch(
      /^repositories:1:microfrontend created:<2030-01-01$/,
    );
    expect(output).toContain('| p | p#created:<2030-01-01 |');
    expect(output).toContain('Saturadas: 2');
    expect(readdirSync(f.directory).sort()).toEqual(before);
  }, 15_000);

  it('should return zero from a dry run when every subquery fits', async () => {
    const f = workspace();
    searchMock({ totalCount: 10 });
    expect(
      await main(['discover', '--queries', f.queries, '--dry-run'], env),
    ).toBe(0);
  });

  it('should return one when a dry-run request fails', async () => {
    const f = workspace();
    const before = readdirSync(f.directory).sort();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ message: 'Bad credentials' }, 401),
    );
    expect(
      await main(['discover', '--queries', f.queries, '--dry-run'], env),
    ).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/401/));
    expect(readdirSync(f.directory).sort()).toEqual(before);
  });

  it('should return one when a report run database is missing', async () => {
    const f = workspace();
    expect(
      await main(['report', '--run', join(f.directory, 'missing')], {}),
    ).toBe(1);
  });

  it('should search both endpoints without collecting metadata and finishes complete', async () => {
    const f = workspace([query({ id: 'repo', q: 'microfrontend' }), codeQuery]);
    const { requested } = searchMock();
    expect(await main(f.args, env)).toBe(0);
    expect(requested).toEqual([
      'repositories:100:microfrontend',
      'code:100:single-spa filename:package.json',
    ]);
    const candidates = readFileSync(join(f.output, 'candidates.csv'), 'utf8');
    expect(candidates).toContain('org/r91');
    expect(candidates).toContain('org/r92');
    expect(candidates).not.toContain('not_applied');
  });

  it('should export a partial run and resumes without repeating completed searches', async () => {
    const f = workspace([query({ id: 'repo', q: 'microfrontend' }), codeQuery]);
    const { requested } = searchMock({ codeFailsFirst: true });
    expect(await main(f.args, env)).toBe(2);
    expect(readFileSync(join(f.output, 'candidates.csv'), 'utf8')).toContain(
      'org/r91',
    );
    expect(await main(['discover', '--resume', f.output], env)).toBe(0);
    expect(requested.filter((r) => r.startsWith('repositories'))).toHaveLength(
      1,
    );
    expect(requested.filter((r) => r.startsWith('code'))).toHaveLength(2);
    expect(readFileSync(join(f.output, 'candidates.csv'), 'utf8')).toContain(
      'org/r92',
    );
  });

  it('should count repository searches with the last push cut and code searches without it', async () => {
    const f = workspace([query({ id: 'repo', q: 'microfrontend' }), codeQuery]);
    writeFileSync(
      f.protocol,
      JSON.stringify({
        eligibility: [{ id: 'push', type: 'last_push', since: '2025-04-01' }],
      }),
    );
    const { requested } = searchMock({ totalCount: 10 });
    expect(
      await main(
        [
          'discover',
          '--queries',
          f.queries,
          '--protocol',
          f.protocol,
          '--dry-run',
        ],
        env,
      ),
    ).toBe(0);
    expect(requested).toEqual([
      'repositories:1:microfrontend pushed:>=2025-04-01',
      'code:1:single-spa filename:package.json',
    ]);
    const output = vi
      .mocked(console.log)
      .mock.calls.map(([line]) => String(line))
      .join('\n');
    expect(output).toContain('microfrontend pushed:>=2025-04-01');
    expect(output).not.toContain('filename:package.json pushed:');
  });

  describe('activity options without eligibility rules', () => {
    it.each([
      ['no protocol', undefined],
      ['an empty protocol', { eligibility: [] }],
    ])('should reject them on a new run with %s', async (_label, protocol) => {
      const f = workspace();
      const fetch = vi.spyOn(globalThis, 'fetch');
      const args = [...f.args, '--activity-max-requests', '5'];
      if (protocol) {
        writeFileSync(f.protocol, JSON.stringify(protocol));
        args.push('--protocol', f.protocol);
      }
      expect(await main(args, env)).toBe(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(/Activity options require a protocol with/),
      );
      expect(existsSync(f.output)).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should reject them when resuming a run whose stored protocol has no rules', async () => {
      const f = workspace();
      searchMock();
      expect(await main(f.args, env)).toBe(0);
      const path = join(f.output, 'discovery.sqlite');
      const before = readFileSync(path);
      const fetch = vi.mocked(globalThis.fetch);
      fetch.mockClear();
      expect(
        await main(
          ['discover', '--resume', f.output, '--activity-max-requests', '5'],
          env,
        ),
      ).toBe(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(/Activity options require a protocol with/),
      );
      expect(readFileSync(path)).toEqual(before);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should accept them on a run whose protocol has rules', async () => {
      const f = workspace();
      mockGitHub();
      expect(
        await main(
          [...f.args, '--protocol', f.protocol, '--activity-max-requests', '5'],
          env,
        ),
      ).toBe(0);
    });
  });
});
