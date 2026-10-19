import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { canonicalJson } from '@/common/canonical-json.js';
import { type CommandRunner, runCommand } from '@/common/command.js';
import {
  binaryReason,
  type ExclusionRules,
  exclusionReason,
} from './exclusion.js';
import { measure } from './measures.js';

/** A missing blob must fail the snapshot, never be fetched from the network. */
export const GIT_ENV = { GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };

const SYMLINK_MODE = '120000';
const GITLINK_MODE = '160000';
const EXECUTABLE_MODE = '100755';
/** Directory inside a snapshot that holds the repository files. */
export const FILES_DIRECTORY = 'files';
export const NORMALIZATION_FILE = 'normalization.json';

export type Normalization = {
  schema: 1;
  id: string;
  fullName: string;
  commit: string;
  acquiredAt: string;
  rules: ExclusionRules;
  removed: Array<{ path: string; reason: string; size: number }>;
  submodules: Array<{ path: string; commit: string }>;
  symlinks: Array<{ path: string; target: string }>;
  kept: { files: number; bytes: number };
  /** Bytes per language by file extension, largest first. */
  languages: Record<string, number>;
  /** SHA-256 of the canonical list of `{ path, mode, sha256 }` of the kept files. */
  contentSha256: string;
};

export type SnapshotOptions = {
  id: string;
  fullName: string;
  /** The clone, read through its object database only. */
  repository: string;
  commit: string;
  /** The final snapshot directory; it is written as `<destination>.partial` first. */
  destination: string;
  rules: ExclusionRules;
  run?: CommandRunner;
  signal?: AbortSignal;
  now?: () => Date;
};

type TreeEntry = {
  mode: string;
  type: string;
  oid: string;
  size: number;
  path: string;
};

/** Parses `git ls-tree -r -z --long`: `<mode> <type> <oid> <size>\t<path>` records ended by NUL. */
export function parseTree(output: string): TreeEntry[] {
  return output
    .split('\0')
    .filter((record) => record !== '')
    .map((record) => {
      const tab = record.indexOf('\t');
      const [mode, type, oid, size] = record.slice(0, tab).split(/\s+/);
      return {
        mode: mode as string,
        type: type as string,
        oid: oid as string,
        size: size === '-' ? 0 : Number(size),
        path: record.slice(tab + 1),
      };
    });
}

/** Reads the replies of one `git cat-file --batch` process in order. */
class BatchReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private readonly iterator: AsyncIterator<Buffer>;

  constructor(
    stream: Readable,
    private readonly failure: () => string,
  ) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  private async fill(): Promise<void> {
    const next = await this.iterator.next();
    if (next.done)
      throw new Error(`git cat-file ended early: ${this.failure()}`);
    this.chunks.push(next.value);
    this.length += next.value.length;
  }

  private take(count: number): Buffer {
    const all =
      this.chunks.length === 1
        ? (this.chunks[0] as Buffer)
        : Buffer.concat(this.chunks);
    const rest = all.subarray(count);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return all.subarray(0, count);
  }

  async line(): Promise<string> {
    for (;;) {
      const all =
        this.chunks.length === 1
          ? (this.chunks[0] as Buffer)
          : Buffer.concat(this.chunks);
      this.chunks = all.length > 0 ? [all] : [];
      const end = all.indexOf(10);
      if (end >= 0) return this.take(end + 1).toString('utf8', 0, end);
      await this.fill();
    }
  }

  async bytes(count: number): Promise<Buffer> {
    while (this.length < count) await this.fill();
    return this.take(count);
  }
}

type BatchReply = { content: Buffer } | { missing: true };

async function readBlob(
  child: ReturnType<typeof spawn>,
  reader: BatchReader,
  oid: string,
): Promise<BatchReply> {
  child.stdin?.write(`${oid}\n`);
  const header = (await reader.line()).split(' ');
  if (header[1] === 'missing') return { missing: true };
  const content = await reader.bytes(Number(header[2]) + 1);
  return { content: content.subarray(0, content.length - 1) };
}

function safeDestination(root: string, path: string): string {
  const target = resolve(root, path);
  const segments = path.split('/');
  if (
    !target.startsWith(root + sep) ||
    segments.some((segment) => segment === '' || segment === '.git')
  )
    throw new Error(`The tree contains the unsafe path ${path}.`);
  return target;
}

/**
 * Writes the tree of `commit` minus the excluded files to `destination`,
 * reading only from the clone's object database. Exclusions that depend on the
 * path or size are decided from the tree listing, before any blob is read.
 */
export async function acquireSnapshot(
  options: SnapshotOptions,
): Promise<Normalization> {
  const run = options.run ?? runCommand;
  const { repository, commit, rules, signal } = options;
  const partial = `${options.destination}.partial`;
  const root = resolve(partial, FILES_DIRECTORY);
  rmSync(partial, { recursive: true, force: true });
  try {
    const tree = parseTree(
      await run('git', ['ls-tree', '-r', '-z', '--long', commit], {
        cwd: repository,
        env: GIT_ENV,
        signal,
      }),
    );
    const removed: Normalization['removed'] = [];
    const submodules: Normalization['submodules'] = [];
    const symlinks: Normalization['symlinks'] = [];
    const wanted: TreeEntry[] = [];
    const symlinkEntries: TreeEntry[] = [];
    for (const entry of tree) {
      const reason = exclusionReason(entry.path, entry.size, rules);
      if (reason !== null)
        removed.push({ path: entry.path, reason, size: entry.size });
      else if (entry.mode === GITLINK_MODE)
        submodules.push({ path: entry.path, commit: entry.oid });
      else if (entry.mode === SYMLINK_MODE) symlinkEntries.push(entry);
      else if (entry.type === 'blob') wanted.push(entry);
    }

    mkdirSync(root, { recursive: true });
    const kept: Array<{
      path: string;
      mode: string;
      sha256: string;
      size: number;
    }> = [];
    if (wanted.length > 0 || symlinkEntries.length > 0) {
      const child = spawn('git', ['cat-file', '--batch'], {
        cwd: repository,
        env: { ...process.env, ...GIT_ENV },
        stdio: ['pipe', 'pipe', 'pipe'],
        signal,
      });
      let stderr = '';
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      child.on('error', () => {});
      const reader = new BatchReader(
        child.stdout as Readable,
        () => stderr.trim() || 'no further output',
      );
      try {
        for (const entry of symlinkEntries) {
          const reply = await readBlob(child, reader, entry.oid);
          if ('missing' in reply)
            throw new Error(
              `The object of ${entry.path} is not in the clone's object database.`,
            );
          symlinks.push({
            path: entry.path,
            target: reply.content.toString('utf8'),
          });
        }
        for (const entry of wanted) {
          const reply = await readBlob(child, reader, entry.oid);
          if ('missing' in reply)
            throw new Error(
              `The blob of ${entry.path} is not in the clone's object database (no network fetch is attempted).`,
            );
          const reason = binaryReason(entry.path, reply.content, rules);
          if (reason !== null) {
            removed.push({
              path: entry.path,
              reason,
              size: reply.content.length,
            });
            continue;
          }
          const target = safeDestination(root, entry.path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, reply.content, {
            mode: entry.mode === EXECUTABLE_MODE ? 0o755 : 0o644,
          });
          kept.push({
            path: entry.path,
            mode: entry.mode,
            sha256: createHash('sha256').update(reply.content).digest('hex'),
            size: reply.content.length,
          });
        }
      } finally {
        child.stdin?.end();
        child.kill();
      }
    }

    kept.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    removed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    submodules.sort((a, b) => (a.path < b.path ? -1 : 1));
    symlinks.sort((a, b) => (a.path < b.path ? -1 : 1));
    const measures = measure(kept);
    const normalization: Normalization = {
      schema: 1,
      id: options.id,
      fullName: options.fullName,
      commit,
      acquiredAt: (options.now ?? (() => new Date()))().toISOString(),
      rules,
      removed,
      submodules,
      symlinks,
      kept: { files: measures.files, bytes: measures.bytes },
      languages: Object.fromEntries(
        measures.languages.map((item) => [item.language, item.bytes]),
      ),
      contentSha256: createHash('sha256')
        .update(
          canonicalJson(
            kept.map(({ path, mode, sha256 }) => ({ path, mode, sha256 })),
          ),
        )
        .digest('hex'),
    };
    writeFileSync(
      join(partial, NORMALIZATION_FILE),
      `${JSON.stringify(normalization, null, 2)}\n`,
    );
    rmSync(options.destination, { recursive: true, force: true });
    renameSync(partial, options.destination);
    return normalization;
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}
