import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createProfileFixture, profileConfig } from '@tests/profile-helpers.js';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '@/cli/main.js';
import { readCsvRecords } from '@/common/csv.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  removeTemporaryDirectories();
});

const identity = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, env: Record<string, string>, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...identity, ...env },
    encoding: 'utf8',
  }).trim();
}

/** A source repository with two commits and a `blob:none` clone of it; returns the clone's commit. */
function partialClone(clone: string): string {
  const source = temporaryDirectory();
  git(source, {}, 'init', '--quiet', '-b', 'main');
  git(source, {}, 'config', 'uploadpack.allowFilter', 'true');
  writeFileSync(join(source, 'a.txt'), 'one');
  git(source, {}, 'add', '-A');
  git(
    source,
    { GIT_COMMITTER_DATE: '2026-09-01T00:00:00+00:00' },
    'commit',
    '--quiet',
    '-m',
    'first',
  );
  writeFileSync(join(source, 'b.txt'), 'two');
  git(source, {}, 'add', '-A');
  git(
    source,
    { GIT_COMMITTER_DATE: '2026-10-01T23:00:00+00:00' },
    'commit',
    '--quiet',
    '-m',
    'second',
  );
  git(
    source,
    {},
    'clone',
    '--quiet',
    '--no-checkout',
    '--filter=blob:none',
    `file://${source}`,
    clone,
  );
  return git(source, {}, 'rev-parse', 'HEAD');
}

/** Hash of every path, mode and content below a directory, `.git` included. */
function fingerprint(directory: string): string {
  const hash = createHash('sha256');
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name);
      hash.update(`${path}\0${statSync(path).mode}\0`);
      if (entry.isDirectory()) walk(path);
      else hash.update(readFileSync(path));
    }
  };
  walk(directory);
  return hash.digest('hex');
}

function recordPage(
  output: string,
  endpoint: string,
  url: string,
  body: unknown,
) {
  const directory = join(output, 'api', 'org__a');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${endpoint}-1.json`),
    JSON.stringify({
      url,
      fetchedAt: '2026-10-24T12:00:00.000Z',
      status: 200,
      body,
      next: null,
    }),
  );
}

describe('profile CLI', () => {
  it('should profile a partial clone from recorded API pages without the network and leave the clone untouched', async () => {
    const fixture = await createProfileFixture([
      {
        fullName: 'org/a',
        files: {
          'src/index.ts': 'x'.repeat(30),
          'package-lock.json': 'x'.repeat(100),
        },
        noClone: true,
        columns: { repo_type: 'example', approaches: 'single-spa' },
      },
    ]);
    const clone = join(fixture.sample, 'repos', 'org__a');
    const commit = partialClone(clone);
    // The fixture recorded a placeholder commit; point both files at the real one.
    for (const file of [
      join(fixture.acquisition, 'acquisition.csv'),
      join(fixture.sample, 'clones.csv'),
    ])
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replaceAll('a'.repeat(40), commit),
      );

    const reviews = temporaryDirectory();
    for (const [folder, body] of [
      ['structure', 'Apps: 4'],
      [
        'composition',
        '## Relations\n\n| # | Type |\n|---|---|\n| 1 | communication |\n\nUnrelated: none',
      ],
    ] as const) {
      mkdirSync(join(reviews, folder));
      writeFileSync(
        join(reviews, folder, '001.md'),
        `---\nfull_name: org/a\ncommit: ${commit}\nannotation:\n  status: final\n---\n\n${body}\n`,
      );
    }
    const config = profileConfig(fixture.acquisition, {
      reviews: profileConfig('x').reviews.map((review) => ({
        ...review,
        files: join(reviews, review.files.replace('reviews/', '')),
      })),
    });
    const directory = temporaryDirectory();
    const configPath = join(directory, 'config.json');
    const output = join(directory, 'out');
    writeFileSync(configPath, JSON.stringify(config));
    const base = 'https://api.github.com/repos/org/a';
    recordPage(output, 'repository', base, {
      created_at: '2026-01-01T00:00:00Z',
    });
    recordPage(output, 'stargazers-count', `${base}/stargazers/count`, {
      count: 7,
    });
    recordPage(output, 'forks', `${base}/forks?per_page=100&sort=oldest`, [
      { created_at: '2026-09-01T00:00:00Z' },
    ]);
    recordPage(
      output,
      'commits',
      `${base}/commits?sha=${commit}&per_page=100`,
      [
        {
          author: { login: 'ana', type: 'User' },
          commit: { author: { name: 'Ana', email: 'a@x.com' } },
        },
        {
          author: { login: 'bo', type: 'User' },
          commit: { author: { name: 'Bo', email: 'b@x.com' } },
        },
      ],
    );

    const network = vi.fn(() => {
      throw new Error('the network must not be used');
    });
    vi.stubGlobal('fetch', network);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = fingerprint(clone);
    const code = await main(
      ['profile', '--config', configPath, '--output', output],
      {},
    );

    expect(code).toBe(0);
    expect(network).not.toHaveBeenCalled();
    expect(fingerprint(clone)).toBe(before);
    const [row] = await readCsvRecords(join(output, 'profile.csv'));
    expect(row).toMatchObject({
      full_name: 'org/a',
      commit_sha: commit,
      files: '2',
      excluded_files: '1',
      dominant_language: 'TypeScript',
      commits: '2',
      last_commit_at: '2026-10-01T23:00:00Z',
      days_since_last_commit: '10',
      created_at: '2026-01-01T00:00:00Z',
      age_days: '284',
      stars: '7',
      stars_observed_at: '2026-10-24T12:00:00.000Z',
      forks: '1',
      contributors: '2',
      api_status: '200',
      domain: 'example',
      approach: 'single-spa',
      snapshot_apps: '4',
      unrelated_units: '0',
      relation_types: 'communication',
      units: '4',
    });
    expect(readFileSync(join(output, 'report.md'), 'utf8')).toContain(
      '# Perfil dos repositórios',
    );
    const validation = await readCsvRecords(join(output, 'validation.csv'));
    expect(validation).toHaveLength(1);
    expect(validation[0]).toMatchObject({
      measure: 'commits',
      difference: '0',
    });
  });
});
