import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@/common/canonical-json.js';
import { type CommandRunner, runCommand } from '@/common/command.js';
import { readCsvRecords, writeCsv } from '@/common/csv.js';
import { sha256File } from '@/common/hash.js';
import { isRecord } from '@/common/records.js';
import { directoryName } from '@/modules/sampling/clone.js';
import { assertSampleIntact } from '@/modules/sampling/integrity.js';
import { readAnnotations, valueAt } from './annotations.js';
import type { AcquisitionConfig } from './config.js';
import { formatLanguages } from './measures.js';
import { type Provenance, readProvenance } from './provenance.js';
import {
  type ClonedRepository,
  type SelectedRepository,
  selectRepositories,
} from './selection.js';
import {
  acquireSnapshot,
  NORMALIZATION_FILE,
  type Normalization,
} from './snapshot.js';

/** First git release where `GIT_NO_LAZY_FETCH` makes a missing object fail instead of being fetched. */
const MIN_GIT_VERSION = [2, 44];

export const ACQUISITION_COLUMNS = [
  'id',
  'full_name',
  'url',
  'commit_sha',
  'default_branch',
  'discovered_at',
  'acquired_at',
  'strategies',
  'discovery_language',
  'discovery_size_kb',
  'files',
  'bytes',
  'languages_by_extension',
  'content_sha256',
];

export type AcquireOptions = {
  config: AcquisitionConfig;
  outputDir: string;
  run?: CommandRunner;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, label: string) => void;
  now?: () => Date;
};

export type AcquireFailure = { id: string; fullName: string; error: string };

export type AcquireResult = {
  /** Repositories the annotations select. */
  selected: number;
  /** Selected repositories with a complete snapshot, including earlier runs. */
  acquired: number;
  /** Snapshots written by this run. */
  written: number;
  failures: AcquireFailure[];
  /** Annotations of the sample left out by classification or state. */
  unselected: number;
  /** Acquired earlier, no longer selected: kept on disk, out of acquisition.csv. */
  noLongerSelected: Array<{ id: string; fullName: string }>;
  interrupted: boolean;
};

type RankedRow = { url: string; strategies: string };

function summarize(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 500 ? `${line.slice(0, 500)}…` : line;
}

async function assertGitSupported(run: CommandRunner): Promise<void> {
  let output: string;
  try {
    output = await run('git', ['--version'], {});
  } catch {
    throw new Error(
      'git was not found in PATH; the acquire command requires it.',
    );
  }
  const match = /(\d+)\.(\d+)/.exec(output);
  const [major, minor] = [Number(match?.[1]), Number(match?.[2])];
  const [needMajor, needMinor] = MIN_GIT_VERSION as [number, number];
  if (!match || major < needMajor || (major === needMajor && minor < needMinor))
    throw new Error(
      `acquire requires git ${needMajor}.${needMinor} or newer (found: ${output.trim()}).`,
    );
}

function requireFiles(directory: string, names: string[]): void {
  for (const name of names)
    if (!existsSync(join(directory, name)))
      throw new Error(`${directory} does not contain ${name}.`);
}

async function readClones(directory: string): Promise<ClonedRepository[]> {
  const rows = await readCsvRecords(join(directory, 'clones.csv'), [
    'rank',
    'id',
    'full_name',
    'status',
    'commit_sha',
  ]);
  const byId = new Map<string, ClonedRepository>();
  for (const row of rows)
    if (row.status === 'cloned')
      byId.set(row.id as string, {
        rank: Number(row.rank),
        id: row.id as string,
        fullName: row.full_name as string,
        commit: row.commit_sha as string,
        branch: row.branch ?? '',
      });
  return [...byId.values()];
}

async function readCatalog(directory: string): Promise<Map<string, string>> {
  const rows = await readCsvRecords(join(directory, 'catalog.csv'), [
    'id',
    'classification',
  ]);
  return new Map(
    rows.map((row) => [row.id as string, row.classification as string]),
  );
}

async function readRanked(directory: string): Promise<Map<string, RankedRow>> {
  const rows = await readCsvRecords(join(directory, 'ranking.csv'), [
    'id',
    'url',
    'strategies',
  ]);
  return new Map(
    rows.map((row) => [
      row.id as string,
      { url: row.url as string, strategies: row.strategies as string },
    ]),
  );
}

type OutputManifest = {
  createdAt: string;
  configSha256: string;
  sample: Record<string, string>;
};

function readOutputManifest(path: string): OutputManifest | null {
  if (!existsSync(path)) return null;
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !isRecord(value) ||
    typeof value.configSha256 !== 'string' ||
    !isRecord(value.sample)
  )
    throw new Error(`${path} is not an acquisition manifest.`);
  return {
    createdAt: String(value.createdAt ?? ''),
    configSha256: value.configSha256,
    sample: value.sample as Record<string, string>,
  };
}

function readNormalization(directory: string): Normalization | null {
  const path = join(directory, NORMALIZATION_FILE);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(value) && typeof value.commit === 'string'
      ? (value as Normalization)
      : null;
  } catch {
    return null;
  }
}

/** The CSV cell for an annotated value: lists joined by `;`, maps as JSON, null as empty. */
function exported(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(exported).join(';');
  if (isRecord(value)) return canonicalJson(value);
  return String(value);
}

/** Directories of `corpus/` that hold a complete snapshot, keyed by repository id. */
function completeSnapshots(corpus: string): Map<string, Normalization> {
  const found = new Map<string, Normalization>();
  if (!existsSync(corpus)) return found;
  for (const name of readdirSync(corpus)) {
    if (name.endsWith('.partial')) continue;
    const normalization = readNormalization(join(corpus, name));
    if (normalization !== null) found.set(normalization.id, normalization);
  }
  return found;
}

function problemReport(problems: string[]): Error {
  return new Error(
    `The inputs have ${problems.length} problem${problems.length === 1 ? '' : 's'}; nothing was written:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  );
}

/**
 * Validates the sample and the annotations, then writes a normalized snapshot of
 * every selected repository at its classified commit. Nothing is written when
 * an input is inconsistent, and a rerun keeps the complete snapshots.
 */
export async function acquire(options: AcquireOptions): Promise<AcquireResult> {
  const { config, outputDir, signal } = options;
  const run = options.run ?? runCommand;
  const now = options.now ?? (() => new Date());
  const sampleDirectory = config.sample;
  requireFiles(sampleDirectory, [
    'sample.csv',
    'ranking.csv',
    'manifest.json',
    'clones.csv',
    'catalog.csv',
  ]);
  const samplePath = join(sampleDirectory, 'sample.csv');
  const rankingPath = join(sampleDirectory, 'ranking.csv');
  await assertSampleIntact(join(sampleDirectory, 'manifest.json'), [
    samplePath,
    rankingPath,
  ]);
  await assertGitSupported(run);

  const clones = await readClones(sampleDirectory);
  const catalog = await readCatalog(sampleDirectory);
  const ranked = await readRanked(sampleDirectory);
  const reading = await readAnnotations(
    config.annotations.files,
    config.annotations.statusField,
  );
  const selection = selectRepositories(reading.annotations, clones, catalog, {
    include: config.include,
    required: config.annotations.required,
  });
  const problems = [...reading.problems, ...selection.problems];
  for (const field of config.annotations.export)
    if (ACQUISITION_COLUMNS.includes(field))
      problems.push(
        `annotations.export: ${field} collides with a column of acquisition.csv`,
      );
  if (problems.length > 0) throw problemReport(problems);

  const configSha256 = createHash('sha256')
    .update(canonicalJson(config))
    .digest('hex');
  const sampleHashes = {
    'ranking.csv': await sha256File(rankingPath),
    'sample.csv': await sha256File(samplePath),
  };
  const manifestPath = join(outputDir, 'manifest.json');
  const previous = readOutputManifest(manifestPath);
  if (
    previous !== null &&
    (previous.configSha256 !== configSha256 ||
      canonicalJson(previous.sample) !== canonicalJson(sampleHashes))
  )
    throw new Error(
      `${outputDir} was made with another configuration or sample (manifest.json records config ${previous.configSha256}, this run has ${configSha256}); use another output directory.`,
    );

  const selected = selection.selected;
  const provenance = await readProvenance(
    sampleDirectory,
    selected.map((item) => item.clone.id),
  );

  const corpus = join(outputDir, 'corpus');
  mkdirSync(corpus, { recursive: true });
  for (const name of readdirSync(corpus))
    if (name.endsWith('.partial'))
      rmSync(join(corpus, name), { recursive: true, force: true });
  const createdAt = previous?.createdAt || now().toISOString();
  const writeManifest = (annotations: Record<string, string>) =>
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          schema: 1,
          createdAt,
          config,
          configSha256,
          sample: sampleHashes,
          annotations,
          notSelected: noLongerSelected,
        },
        null,
        2,
      )}\n`,
    );

  const selectedIds = new Set(selected.map((item) => item.clone.id));
  const existing = completeSnapshots(corpus);
  const noLongerSelected = [...existing.values()]
    .filter((snapshot) => !selectedIds.has(snapshot.id))
    .map((snapshot) => ({ id: snapshot.id, fullName: snapshot.fullName }));
  writeManifest({});

  const result: AcquireResult = {
    selected: selected.length,
    acquired: 0,
    written: 0,
    failures: [],
    unselected: selection.unselected,
    noLongerSelected,
    interrupted: false,
  };
  const snapshots = new Map<string, Normalization>();
  for (const item of selected) {
    const kept = existing.get(item.clone.id);
    if (kept?.commit === item.clone.commit) snapshots.set(item.clone.id, kept);
  }
  result.acquired = snapshots.size;
  options.onProgress?.(result.acquired, selected.length, '');
  for (const item of selected) {
    if (snapshots.has(item.clone.id)) continue;
    if (signal?.aborted) {
      result.interrupted = true;
      break;
    }
    const { clone } = item;
    options.onProgress?.(result.acquired, selected.length, clone.fullName);
    try {
      const normalization = await acquireSnapshot({
        id: clone.id,
        fullName: clone.fullName,
        repository: join(
          sampleDirectory,
          'repos',
          directoryName(clone.fullName),
        ),
        commit: clone.commit,
        destination: join(corpus, directoryName(clone.fullName)),
        rules: config.exclude,
        run,
        signal,
        now,
      });
      snapshots.set(clone.id, normalization);
      result.acquired += 1;
      result.written += 1;
    } catch (failure) {
      if (signal?.aborted) {
        result.interrupted = true;
        break;
      }
      result.failures.push({
        id: clone.id,
        fullName: clone.fullName,
        error: summarize(failure),
      });
    }
    options.onProgress?.(result.acquired, selected.length, clone.fullName);
  }

  const done = selected.filter((item) => snapshots.has(item.clone.id));
  await writeCsv(
    join(outputDir, 'acquisition.csv'),
    [...ACQUISITION_COLUMNS, ...config.annotations.export],
    done.map((item) =>
      acquisitionRow(
        item,
        snapshots.get(item.clone.id) as Normalization,
        ranked.get(item.clone.id),
        provenance.get(item.clone.id),
        config.annotations.export,
      ),
    ),
  );
  writeManifest(
    Object.fromEntries(
      done.map((item) => [item.clone.id, item.annotation.sha256]),
    ),
  );
  return result;
}

function acquisitionRow(
  item: SelectedRepository,
  normalization: Normalization,
  ranking: RankedRow | undefined,
  discovery: Provenance | undefined,
  exportFields: string[],
): unknown[] {
  const { clone, annotation } = item;
  return [
    clone.id,
    clone.fullName,
    ranking?.url ?? `https://github.com/${clone.fullName}`,
    clone.commit,
    clone.branch,
    discovery?.discoveredAt ?? '',
    normalization.acquiredAt,
    ranking?.strategies ?? '',
    discovery?.language ?? '',
    discovery?.sizeKb ?? '',
    normalization.kept.files,
    normalization.kept.bytes,
    formatLanguages(
      Object.entries(normalization.languages).map(([language, bytes]) => ({
        language,
        bytes,
      })),
    ),
    normalization.contentSha256,
    ...exportFields.map((field) => exported(valueAt(annotation.data, field))),
  ];
}
