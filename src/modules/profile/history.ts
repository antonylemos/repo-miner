import type { CommandRunner } from '@/common/command.js';

export type CommitHistory = {
  commits: number;
  /** Committer date of the snapshot commit, as git prints it (`%cI`). */
  lastCommitAt: string;
};

const DAY_MS = 86_400_000;

/**
 * Runs git in a clone without writing to it: no lazy fetch of the objects a
 * partial clone lacks, no optional locks, no background maintenance.
 */
function git(
  run: CommandRunner,
  clone: string,
  args: string[],
): Promise<string> {
  return run(
    'git',
    [
      '--no-optional-locks',
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      ...args,
    ],
    { cwd: clone, env: { GIT_NO_LAZY_FETCH: '1' } },
  );
}

/** Whether the clone has the commit. */
export async function hasCommit(
  run: CommandRunner,
  clone: string,
  commit: string,
): Promise<boolean> {
  try {
    await git(run, clone, ['cat-file', '-e', `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The ancestors of the commit, itself included, and its committer date. */
export async function readHistory(
  run: CommandRunner,
  clone: string,
  commit: string,
): Promise<CommitHistory> {
  const count = await git(run, clone, ['rev-list', '--count', commit]);
  // `git show` needs an object some blob:none clones lack; `log -1` reads only the commit.
  const date = await git(run, clone, ['log', '-1', '--format=%cI', commit]);
  const commits = Number(count.trim());
  if (!Number.isSafeInteger(commits))
    throw new Error(`git rev-list --count printed ${count.trim()} in ${clone}`);
  return { commits, lastCommitAt: date.trim() };
}

/** Whole days from `from` to `to`; a partial day does not count. */
export function wholeDays(from: string, to: string): number {
  return Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);
}
