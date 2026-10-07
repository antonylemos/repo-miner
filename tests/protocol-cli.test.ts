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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';
import { openProtocolStore } from '../src/discovery/storage/protocol-store.js';
import { query } from './helpers.js';
import { humanActivityRule, restCommitPayload } from './protocol-helpers.js';

const env = { GITHUB_TOKEN: 'fake-token' };
const directories: string[] = [];
function fixture(version = 3) {
  const directory = mkdtempSync(join(tmpdir(), 'protocol-cli-'));
  directories.push(directory);
  const queries = join(directory, 'catalog.json');
  const protocol = join(directory, 'protocol.json');
  const output = join(directory, 'run');
  writeFileSync(
    queries,
    JSON.stringify({
      version,
      ...(version === 2 ? { filters: { pushedSince: '2024-01-01' } } : {}),
      queries: [query({ id: 'q' })],
    }),
  );
  writeFileSync(
    protocol,
    JSON.stringify({ version: 1, eligibility: [humanActivityRule()] }),
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
  it('v3 without a protocol collects nothing and reports offline', async () => {
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
    const store = openProtocolStore(join(f.output, 'discovery.sqlite'));
    expect([...store.iterateCandidates()][0]?.evaluation?.status).toBe(
      'not_applied',
    );
    store.close();
  });
  it('real metadata factory counts one global attempt for two targets and facts query carries oid', async () => {
    const f = fixture();
    const fetch = mockGitHub();
    expect(await main([...f.args, '--protocol', f.protocol], env)).toBe(0);
    const store = openProtocolStore(join(f.output, 'discovery.sqlite'));
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
  it('terminal unknown author is a complete run', async () => {
    const f = fixture();
    mockGitHub({ unknown: true });
    expect(await main([...f.args, '--protocol', f.protocol], env)).toBe(0);
    const store = openProtocolStore(join(f.output, 'discovery.sqlite'));
    expect([...store.iterateCandidates()][0]?.evaluation?.status).toBe(
      'unknown',
    );
    expect(store.getRun().state).toBe('complete');
    store.close();
  });
  it('activity retries consume the actual per-invocation budget and resume gets a fresh invocation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetch = mockGitHub({ retry: true });
    const running = main(
      [...f.args, '--protocol', f.protocol, '--activity-max-requests', '1'],
      env,
    );
    await vi.runAllTimersAsync();
    expect(await running).toBe(2);
    let store = openProtocolStore(join(f.output, 'discovery.sqlite'));
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
    store = openProtocolStore(join(f.output, 'discovery.sqlite'));
    expect(store.getRun().invocations).toHaveLength(2);
    expect(store.getRun().invocations[1]?.id).not.toBe(initial);
    expect(store.readCollectionSummary().metadata.attempts).toBe(1);
    store.close();
  });
  it.each(['0', '-1', '1.2', 'NaN', 'Infinity'])(
    'rejects invalid budgets %s before creating output or HTTP',
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
  it('rejects oversized pages, invalid protocols, v2 policy/budgets and explicit dry-run budgets', async () => {
    const f = fixture();
    const legacy = fixture(2);
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const args of [
      [...f.args, '--activity-commits-per-page', '101'],
      [...f.args, '--activity-branches-per-page', '101'],
      [...legacy.args, '--protocol', legacy.protocol],
      [...legacy.args, '--activity-max-requests', '20'],
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
    writeFileSync(f.protocol, '{"version":1,"eligibility":[{}]}');
    expect(await main([...f.args, '--protocol', f.protocol], env)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(f.output)).toBe(false);
    expect(existsSync(legacy.output)).toBe(false);
  });
  it('accepts policy dry-run without collection and reports saturation as 2', async () => {
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
  it('rejects replacement and malformed stored resume config before HTTP or database writes', async () => {
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
        kind: 'protocol',
        catalog: { version: 3, queries: [] },
        protocol: { version: 1, eligibility: [] },
      }),
    );
    db.close();
    const malformed = readFileSync(path);
    expect(await main(['discover', '--resume', f.output], env)).toBe(1);
    expect(readFileSync(path)).toEqual(malformed);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    JSON.stringify({
      kind: 'protocol',
      catalog: { version: 3, queries: [] },
      protocol: { version: 1, eligibility: [] },
    }),
    '{unparsable',
  ])(
    'rejects malformed stored report policy without changing database or outputs: %s',
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
      const inspected = new DatabaseSync(path, { readOnly: true });
      expect(inspected.prepare('PRAGMA user_version').get()?.user_version).toBe(
        3,
      );
      inspected.close();
      for (const name of outputs)
        expect(readFileSync(join(f.output, name), 'utf8')).toBe(
          `sentinel:${name}`,
        );
    },
  );
  it('hard-crash resume attributes metadata to a fresh invocation and preserves stored policy', async () => {
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
    const store = openProtocolStore(path);
    const initial = store.getRun().invocations[0]?.id;
    store.close();
    expect(await main(['discover', '--resume', f.output], env)).toBe(0);
    const resumed = openProtocolStore(path);
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
  it('rejects unsupported schema without network or writes', async () => {
    const f = fixture();
    mockGitHub();
    expect(await main(f.args, env)).toBe(0);
    const path = join(f.output, 'discovery.sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 999');
    db.close();
    const before = readFileSync(path);
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockClear();
    expect(await main(['discover', '--resume', f.output], env)).toBe(1);
    expect(await main(['report', '--run', f.output], {})).toBe(1);
    expect(readFileSync(path)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('real transport retries attribute every activity attempt to the active invocation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetch = mockGitHub({ retry: true });
    const running = main(
      [...f.args, '--protocol', f.protocol, '--activity-max-requests', '2'],
      env,
    );
    await vi.runAllTimersAsync();
    expect(await running).toBe(0);
    const store = openProtocolStore(join(f.output, 'discovery.sqlite'));
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
  it('metadata retries count once per batch globally rather than once per target', async () => {
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
    const store = openProtocolStore(join(f.output, 'discovery.sqlite'));
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
  it('schema 2 resumes reject explicit v3 budgets while preserving legacy defaults', async () => {
    const f = fixture(2);
    const fetch = mockGitHub();
    expect(await main(f.args, env)).toBe(0);
    fetch.mockClear();
    const path = join(f.output, 'discovery.sqlite');
    const before = readFileSync(path);
    expect(
      await main(
        ['discover', '--resume', f.output, '--activity-max-requests', '20'],
        env,
      ),
    ).toBe(1);
    expect(readFileSync(path)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    expect(await main(['discover', '--resume', f.output], env)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('v3 discovery saturation returns 2 and exports partial results', async () => {
    vi.useFakeTimers();
    const f = fixture();
    mockGitHub({ saturated: true });
    const running = main(f.args, env);
    await vi.runAllTimersAsync();
    expect(await running).toBe(2);
    expect(existsSync(join(f.output, 'report.md'))).toBe(true);
  });
});
