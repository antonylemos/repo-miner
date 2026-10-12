import { execFile } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { csvField, readCsv } from '@/common/csv.js';
import { appendToCatalog } from './catalog.js';

const execFileAsync = promisify(execFile);

export const CLONE_COLUMNS = [
  'rank',
  'id',
  'full_name',
  'status',
  'commit_sha',
  'branch',
  'attempted_at',
  'replaces',
  'error',
];
const MAX_ERROR_LENGTH = 500;

/** Runs a command and returns its stdout; rejects with the command's stderr in the message. */
export type CommandRunner = (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<string>;

export const runCommand: CommandRunner = async (file, args, options) => {
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      signal: options.signal,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    const failure = new Error(
      stderr || (error instanceof Error ? error.message : String(error)),
    );
    failure.name = (error as Error).name;
    throw failure;
  }
};

export type CloneOptions = {
  /** Sample directory holding sample.csv and ranking.csv. */
  directory: string;
  remoteUrl: (fullName: string) => string;
  run?: CommandRunner;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, label: string) => void;
  now?: () => Date;
};

export type CloneResult = {
  /** X: the number of repositories the sample asks for. */
  size: number;
  /** Repositories cloned so far, including earlier runs. */
  cloned: number;
  /** Attempts that failed in this run. */
  failed: number;
  exhausted: boolean;
  interrupted: boolean;
};

type RankedRow = { rank: string; id: string; fullName: string; url: string };
type Attempt = {
  id: string;
  status: string;
  fullName: string;
  replaces: string;
};

async function readRows(
  path: string,
  columns: string[],
): Promise<Array<Record<string, string>>> {
  const rows: Array<Record<string, string>> = [];
  let header: string[] | null = null;
  for await (const row of readCsv(path)) {
    if (header === null) {
      header = row;
      const missing = columns.filter((name) => !header?.includes(name));
      if (missing.length > 0)
        throw new Error(`${path} lacks the columns ${missing.join(', ')}.`);
      continue;
    }
    if (row.length === 1 && row[0] === '') continue;
    rows.push(
      Object.fromEntries(header.map((name, index) => [name, row[index] ?? ''])),
    );
  }
  return rows;
}

async function readRanking(directory: string): Promise<RankedRow[]> {
  const rows = await readRows(join(directory, 'ranking.csv'), [
    'rank',
    'id',
    'full_name',
    'url',
  ]);
  return rows.map((row) => ({
    rank: row.rank as string,
    id: row.id as string,
    fullName: row.full_name as string,
    url: row.url as string,
  }));
}

async function readAttempts(path: string): Promise<Attempt[]> {
  if (!existsSync(path)) return [];
  const rows = await readRows(path, ['id', 'full_name', 'status', 'replaces']);
  return rows.map((row) => ({
    id: row.id as string,
    status: row.status as string,
    fullName: row.full_name as string,
    replaces: row.replaces as string,
  }));
}

export function directoryName(fullName: string): string {
  return fullName.replace('/', '__');
}

/** Drops partial clones and clone directories that no clones.csv row vouches for. */
function discardOrphans(reposDirectory: string, kept: Set<string>): void {
  if (!existsSync(reposDirectory)) return;
  for (const name of readdirSync(reposDirectory))
    if (name.endsWith('.partial') || !kept.has(name))
      rmSync(join(reposDirectory, name), { recursive: true, force: true });
}

export async function assertGitAvailable(run: CommandRunner): Promise<void> {
  try {
    await run('git', ['--version'], {});
  } catch {
    throw new Error(
      'git was not found in PATH; the clone command requires it.',
    );
  }
}

function summarize(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_ERROR_LENGTH
    ? `${line.slice(0, MAX_ERROR_LENGTH)}…`
    : line;
}

/**
 * Clones the sample's repositories one at a time. A failed clone is replaced
 * by the next repository in the ranking, every attempt is appended to
 * clones.csv, and a rerun picks up from what clones.csv already records.
 */
export async function cloneSample(options: CloneOptions): Promise<CloneResult> {
  const run = options.run ?? runCommand;
  const now = options.now ?? (() => new Date());
  const { directory, signal } = options;
  const samplePath = join(directory, 'sample.csv');
  const rankingPath = join(directory, 'ranking.csv');
  for (const path of [samplePath, rankingPath])
    if (!existsSync(path))
      throw new Error(
        `${directory} does not contain ${path.split('/').at(-1)}.`,
      );
  await assertGitAvailable(run);

  const size = (await readRows(samplePath, ['id'])).length;
  const ranking = await readRanking(directory);
  const clonesPath = join(directory, 'clones.csv');
  const catalogPath = join(directory, 'catalog.csv');
  const reposDirectory = join(directory, 'repos');
  const attempts = await readAttempts(clonesPath);
  const attempted = new Set(attempts.map((attempt) => attempt.id));
  const cloned = attempts.filter((attempt) => attempt.status === 'cloned');
  const replaced = new Set(
    attempts.map((attempt) => attempt.replaces).filter((id) => id !== ''),
  );
  const unreplaced = attempts
    .filter(
      (attempt) => attempt.status === 'failed' && !replaced.has(attempt.id),
    )
    .map((attempt) => attempt.id);
  const byId = new Map(ranking.map((row) => [row.id, row]));

  mkdirSync(reposDirectory, { recursive: true });
  discardOrphans(
    reposDirectory,
    new Set(cloned.map((attempt) => directoryName(attempt.fullName))),
  );
  // A crash between clones.csv and catalog.csv leaves a cloned repository out of the catalog.
  await appendToCatalog(
    catalogPath,
    cloned.flatMap((attempt) => {
      const row = byId.get(attempt.id);
      return row ? [{ id: Number(row.id), url: row.url }] : [];
    }),
  );
  if (!existsSync(clonesPath))
    appendFileSync(clonesPath, `${CLONE_COLUMNS.join(',')}\n`, 'utf8');

  const result: CloneResult = {
    size,
    cloned: cloned.length,
    failed: 0,
    exhausted: false,
    interrupted: false,
  };
  const queue = ranking.filter((row) => !attempted.has(row.id));
  options.onProgress?.(result.cloned, size, '');
  for (const row of queue) {
    if (result.cloned >= size) break;
    if (signal?.aborted) {
      result.interrupted = true;
      break;
    }
    const name = directoryName(row.fullName);
    const partial = join(reposDirectory, `.${name}.partial`);
    const final = join(reposDirectory, name);
    const replaces = Number(row.rank) > size ? (unreplaced.shift() ?? '') : '';
    options.onProgress?.(result.cloned, size, row.fullName);
    let commit = '';
    let branch = '';
    let error = '';
    try {
      rmSync(partial, { recursive: true, force: true });
      await run(
        'git',
        [
          'clone',
          '--filter=blob:none',
          '--quiet',
          options.remoteUrl(row.fullName),
          partial,
        ],
        { env: { GIT_TERMINAL_PROMPT: '0' }, signal },
      );
      commit = (
        await run('git', ['rev-parse', 'HEAD'], { cwd: partial, signal })
      ).trim();
      branch = (
        await run('git', ['symbolic-ref', '--short', 'HEAD'], {
          cwd: partial,
          signal,
        })
      ).trim();
    } catch (failure) {
      error = summarize(failure) || 'git clone failed';
    }
    if (signal?.aborted) {
      rmSync(partial, { recursive: true, force: true });
      result.interrupted = true;
      break;
    }
    if (error === '') {
      rmSync(final, { recursive: true, force: true });
      renameSync(partial, final);
    } else {
      rmSync(partial, { recursive: true, force: true });
    }
    const status = error === '' ? 'cloned' : 'failed';
    appendFileSync(
      clonesPath,
      `${[
        row.rank,
        row.id,
        row.fullName,
        status,
        commit,
        branch,
        now().toISOString(),
        replaces,
        error,
      ]
        .map(csvField)
        .join(',')}\n`,
      'utf8',
    );
    if (status === 'cloned') {
      await appendToCatalog(catalogPath, [
        { id: Number(row.id), url: row.url },
      ]);
      result.cloned += 1;
    } else {
      result.failed += 1;
      unreplaced.push(row.id);
    }
    options.onProgress?.(result.cloned, size, row.fullName);
  }
  result.exhausted = result.cloned < size && !result.interrupted;
  return result;
}
