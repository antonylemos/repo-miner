import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '@/common/command.js';
import {
  hasCommit,
  readHistory,
  wholeDays,
} from '@/modules/profile/history.js';

type Call = {
  file: string;
  args: string[];
  options: Parameters<CommandRunner>[2];
};

function fakeRunner(outputs: Record<string, string | Error>) {
  const calls: Call[] = [];
  const run: CommandRunner = async (file, args, options) => {
    calls.push({ file, args, options });
    const key = args.find((arg) =>
      ['cat-file', 'rev-list', 'log'].includes(arg),
    ) as string;
    const output = outputs[key];
    if (output instanceof Error) throw output;
    return output ?? '';
  };
  return { run, calls };
}

const GUARDS = [
  '--no-optional-locks',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
];

describe('readHistory', () => {
  it('should read the count and the committer date with read-only git', async () => {
    const { run, calls } = fakeRunner({
      'rev-list': '42\n',
      log: '2026-10-01T23:00:00+00:00\n',
    });
    const history = await readHistory(run, '/clone', 'abc');
    expect(history).toEqual({
      commits: 42,
      lastCommitAt: '2026-10-01T23:00:00+00:00',
    });
    expect(calls.map((call) => call.args.slice(GUARDS.length))).toEqual([
      ['rev-list', '--count', 'abc'],
      ['log', '-1', '--format=%cI', 'abc'],
    ]);
    for (const call of calls) {
      expect(call.file).toBe('git');
      expect(call.args.slice(0, GUARDS.length)).toEqual(GUARDS);
      expect(call.options.cwd).toBe('/clone');
      expect(call.options.env).toEqual({ GIT_NO_LAZY_FETCH: '1' });
    }
  });

  it('should reject a count that is not a number', async () => {
    const { run } = fakeRunner({ 'rev-list': 'nope', log: 'x' });
    await expect(readHistory(run, '/clone', 'abc')).rejects.toThrow(/nope/);
  });
});

describe('hasCommit', () => {
  it('should ask for the commit object without lazy fetch', async () => {
    const { run, calls } = fakeRunner({ 'cat-file': '' });
    expect(await hasCommit(run, '/clone', 'abc')).toBe(true);
    expect(calls[0]?.args.slice(GUARDS.length)).toEqual([
      'cat-file',
      '-e',
      'abc^{commit}',
    ]);
    expect(calls[0]?.options.env).toEqual({ GIT_NO_LAZY_FETCH: '1' });
  });

  it('should report a missing commit', async () => {
    const { run } = fakeRunner({ 'cat-file': new Error('not a valid object') });
    expect(await hasCommit(run, '/clone', 'abc')).toBe(false);
  });
});

describe('wholeDays', () => {
  it('should count whole days only', () => {
    expect(wholeDays('2026-10-01T23:00:00Z', '2026-10-12T01:00:00Z')).toBe(10);
  });

  it('should compare instants with different offsets', () => {
    expect(wholeDays('2026-10-01T00:00:00+02:00', '2026-10-02T00:00:00Z')).toBe(
      1,
    );
  });
});
