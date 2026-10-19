import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { temporaryDirectory } from '@tests/sampling-helpers.js';
import { writeCsv } from '@/common/csv.js';
import { sha256File } from '@/common/hash.js';

const identity = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export type FixtureOptions = {
  repositories: number;
  /** Classification of repository `n`; defaults to `A`. */
  classification?: (n: number) => string;
  /** Annotation state of repository `n`; defaults to `final`. */
  status?: (n: number) => string;
  /** Files committed to repository `n`; by default every repository is a copy of one template. */
  files?: (n: number) => Record<string, string>;
};

const defaultFiles = (): Record<string, string> => ({
  'README.md': 'repo',
  'src/index.ts': 'export const n = 1;\n',
  'node_modules/dep/index.js': 'module.exports = {};\n',
  'package-lock.json': '{}\n',
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...identity },
    encoding: 'utf8',
  }).trim();
}

function commitFiles(path: string, files: Record<string, string>): string {
  git(path, 'init', '--quiet', '-b', 'main');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), content);
  }
  git(path, 'add', '-A');
  git(path, 'commit', '--quiet', '-m', 'first');
  return git(path, 'rev-parse', 'HEAD');
}

let template: { path: string; commit: string } | undefined;

/**
 * One committed repository per worker, copied for each fixture repository:
 * spawning git for every repository of every test slows the whole suite.
 */
function defaultRepository(): { path: string; commit: string } {
  if (template === undefined) {
    const path = mkdtempSync(join(tmpdir(), 'acquisition-template-'));
    process.once('exit', () => rmSync(path, { recursive: true, force: true }));
    template = { path, commit: commitFiles(path, defaultFiles()) };
  }
  return template;
}

/**
 * A cloned sample, its discovery round and one annotation per repository, laid
 * out the way `sample`, `clone` and the researcher leave them.
 */
export async function createFixture(options: FixtureOptions) {
  const root = temporaryDirectory();
  const sample = join(root, 'sample');
  const round = join(root, 'round');
  const annotations = join(root, 'annotations');
  for (const directory of [sample, round, annotations, join(sample, 'repos')])
    mkdirSync(directory, { recursive: true });
  const numbers = Array.from({ length: options.repositories }, (_, i) => i + 1);
  const classification = options.classification ?? (() => 'A');
  const commits = new Map<number, string>();

  for (const n of numbers) {
    const path = join(sample, 'repos', `org__repo-${n}`);
    if (options.files === undefined) {
      cpSync(defaultRepository().path, path, { recursive: true });
      commits.set(n, defaultRepository().commit);
      continue;
    }
    mkdirSync(path, { recursive: true });
    commits.set(n, commitFiles(path, options.files(n)));
  }

  const rankingColumns = ['rank', 'id', 'full_name', 'url', 'strategies'];
  const rankingRows = numbers.map((n) => [
    n,
    n,
    `org/repo-${n}`,
    `https://github.com/org/repo-${n}`,
    'terminology;technology',
  ]);
  await writeCsv(join(sample, 'ranking.csv'), rankingColumns, rankingRows);
  await writeCsv(join(sample, 'sample.csv'), rankingColumns, rankingRows);
  await writeCsv(
    join(sample, 'clones.csv'),
    [
      'rank',
      'id',
      'full_name',
      'status',
      'commit_sha',
      'branch',
      'attempted_at',
      'replaces',
      'error',
    ],
    numbers.map((n) => [
      n,
      n,
      `org/repo-${n}`,
      'cloned',
      commits.get(n),
      'main',
      '2026-10-12T00:00:00.000Z',
      '',
      '',
    ]),
  );
  await writeCsv(
    join(sample, 'catalog.csv'),
    ['id', 'url', 'classification'],
    numbers.map((n) => [
      n,
      `https://github.com/org/repo-${n}`,
      classification(n),
    ]),
  );
  writeFileSync(
    join(sample, 'manifest.json'),
    JSON.stringify({
      source: { run: round },
      sha256: {
        'ranking.csv': await sha256File(join(sample, 'ranking.csv')),
        'sample.csv': await sha256File(join(sample, 'sample.csv')),
      },
    }),
  );

  await writeCsv(
    join(round, 'discovery-hits.csv'),
    ['query_id', 'fetched_at', 'candidate_id'],
    numbers.flatMap((n) => [
      ['q2', `2026-10-08T18:0${n % 10}:00.000Z`, n],
      ['q1', `2026-10-08T15:0${n % 10}:00.000Z`, n],
    ]),
  );
  await writeCsv(
    join(round, 'candidates.csv'),
    ['id', 'full_name', 'metadata_json'],
    numbers.map((n) => [
      n,
      `org/repo-${n}`,
      n % 2 === 0
        ? JSON.stringify({ language: 'TypeScript', size: 100 + n })
        : JSON.stringify({ description: 'x', fork: false }),
    ]),
  );

  const annotationFile = (n: number) =>
    join(annotations, `${String(n).padStart(3, '0')}-org__repo-${n}.md`);
  /** Writes the annotation of repository `n`; `overrides` replace or (with null) drop front matter lines. */
  const writeAnnotation = (
    n: number,
    overrides: Record<string, string | null> = {},
  ) => {
    const fields: Record<string, string | null> = {
      schema: '1',
      id: String(n),
      full_name: `org/repo-${n}`,
      commit: commits.get(n) as string,
      classification: classification(n),
      repo_type: 'example',
      approaches: '[module-federation, qiankun]',
      checklist: '{ q1: yes, q2: no }',
      annotation: `\n  method: manual\n  status: ${(options.status ?? (() => 'final'))(n)}`,
      ...overrides,
    };
    const lines = Object.entries(fields)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => `${key}: ${value}`);
    writeFileSync(
      annotationFile(n),
      `---\n${lines.join('\n')}\n---\n\n# body\n`,
    );
  };
  for (const n of numbers) writeAnnotation(n);

  const config = {
    sample,
    include: { classification: ['A'], status: ['final'] },
    annotations: {
      files: join(annotations, '[0-9]*.md'),
      required: ['approaches'],
      export: ['repo_type', 'approaches', 'annotation.method'],
    },
    exclude: { presets: ['node', 'binaries'], paths: [] },
  };
  return {
    root,
    sample,
    round,
    commits,
    config,
    output: join(root, 'out'),
    annotationFile,
    writeAnnotation,
  };
}
