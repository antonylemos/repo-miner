import { join } from 'node:path';
import { createAcquisition } from '@tests/mining-helpers.js';
import { describe, expect, it } from 'vitest';
import { listArtifacts } from '@/modules/mining/artifacts.js';
import { parseMiningConfig } from '@/modules/mining/config.js';
import {
  EXCERPT_LENGTH,
  findMatches,
  matchLines,
} from '@/modules/mining/matching.js';

describe('matchLines', () => {
  it('should number the matching lines from 1', () => {
    expect(matchLines('a\nfoo\nb\nfoo bar\n', /foo/)).toEqual([
      { line: 2, excerpt: 'foo' },
      { line: 4, excerpt: 'foo bar' },
    ]);
  });

  it('should drop the carriage return of CRLF lines', () => {
    expect(matchLines('a\r\nfoo\r\n', /foo$/)).toEqual([
      { line: 2, excerpt: 'foo' },
    ]);
  });

  it('should register a line once however many times it matches', () => {
    expect(matchLines('foo foo foo\n', /foo/)).toHaveLength(1);
  });

  it('should cut a long line to the excerpt length', () => {
    const [match] = matchLines(`foo${'x'.repeat(1000)}\n`, /foo/);
    expect(match?.excerpt).toHaveLength(EXCERPT_LENGTH);
  });

  it('should match a last line without a line break', () => {
    expect(matchLines('a\nfoo', /foo/)).toEqual([{ line: 2, excerpt: 'foo' }]);
  });

  it('should not count the empty piece after the final line break', () => {
    expect(matchLines('a\n', /^$/)).toEqual([]);
  });
});

const config = parseMiningConfig({
  acquisition: 'unused',
  version: '1',
  artifactTypes: {
    source: ['**/*.js'],
    'build-config': ['**/webpack.config.js'],
    documentation: ['**/*.md'],
    deployment: ['**/Dockerfile'],
  },
  patterns: [
    {
      id: 'src-dynamic-import',
      artifactTypes: ['source'],
      regex: 'import\\([\'"][^.]',
      rationale: 'Remote import',
    },
    {
      id: 'doc-term',
      artifactTypes: ['documentation'],
      regex: 'micro-?frontends?',
      ignoreCase: true,
      rationale: 'Term in the docs',
    },
    {
      id: 'cfg-remotes',
      artifactTypes: ['build-config'],
      regex: 'remotes\\s*[:=]',
      rationale: 'Remotes',
    },
    {
      id: 'ops-dockerfile',
      artifactTypes: ['deployment'],
      rationale: 'Container build',
    },
  ],
  units: { artifactTypes: ['build-config'] },
});

async function mine(files: Record<string, string>) {
  const acquisition = await createAcquisition([{ fullName: 'org/a', files }]);
  const directory = join(acquisition.snapshot('org/a'), 'files');
  return findMatches(
    directory,
    listArtifacts(directory, config.artifactTypes),
    config.patterns,
  );
}

describe('findMatches', () => {
  it('should register each matching line with its path and number', async () => {
    const matches = await mine({
      'shell/src/App.js': [
        'a',
        'b',
        'c',
        'd',
        "const H = import('headerMf/Header');",
        'x',
        'x',
        'x',
        'x',
        'x',
        'x',
        'x',
        "const P = import('productsMf/Products');",
        "import('./local')",
      ].join('\n'),
    });
    expect(matches).toEqual([
      {
        pattern: 'src-dynamic-import',
        path: 'shell/src/App.js',
        line: 5,
        excerpt: "const H = import('headerMf/Header');",
      },
      {
        pattern: 'src-dynamic-import',
        path: 'shell/src/App.js',
        line: 13,
        excerpt: "const P = import('productsMf/Products');",
      },
    ]);
  });

  it('should ignore case only when the pattern asks', async () => {
    const matches = await mine({ 'README.md': 'Micro-Frontends everywhere\n' });
    expect(matches.map((match) => [match.pattern, match.line])).toEqual([
      ['doc-term', 1],
    ]);
  });

  it('should apply a pattern only to the files with its types', async () => {
    const matches = await mine({
      'README.md': "remotes: { a: 'b' }\n",
      'webpack.config.js': 'plugin({ remotes: {} })\n',
    });
    expect(matches.map((match) => [match.pattern, match.path])).toEqual([
      ['cfg-remotes', 'webpack.config.js'],
    ]);
  });

  it('should register a presence pattern once per file, with no line', async () => {
    const matches = await mine({
      'frontend/Dockerfile': 'FROM node\n',
      'microfrontend/Dockerfile': 'FROM nginx\n',
    });
    expect(matches).toEqual([
      {
        pattern: 'ops-dockerfile',
        path: 'frontend/Dockerfile',
        line: null,
        excerpt: null,
      },
      {
        pattern: 'ops-dockerfile',
        path: 'microfrontend/Dockerfile',
        line: null,
        excerpt: null,
      },
    ]);
  });

  it('should order by catalog, then path, then line', async () => {
    const matches = await mine({
      'z/Dockerfile': 'x',
      'a/Dockerfile': 'x',
      'README.md': 'micro-frontend\nmicro-frontend\n',
      'b.js': "import('x')\nimport('y')\n",
    });
    expect(
      matches.map((match) => `${match.pattern}:${match.path}:${match.line}`),
    ).toEqual([
      'src-dynamic-import:b.js:1',
      'src-dynamic-import:b.js:2',
      'doc-term:README.md:1',
      'doc-term:README.md:2',
      'ops-dockerfile:a/Dockerfile:null',
      'ops-dockerfile:z/Dockerfile:null',
    ]);
  });

  it('should find nothing in a snapshot without matches', async () => {
    expect(await mine({ 'logo.svg': '<svg/>', 'a.js': 'let a;\n' })).toEqual(
      [],
    );
  });

  it('should keep searching a file that has a NUL character', async () => {
    const matches = await mine({ 'a.js': "\u0000import('x')\n" });
    expect(matches).toHaveLength(1);
  });

  it('should not keep state between lines with a repeated regex', async () => {
    const matches = await mine({ 'a.js': "import('x')\nimport('x')\n" });
    expect(matches.map((match) => match.line)).toEqual([1, 2]);
  });
});
