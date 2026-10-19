import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parseCsv } from '@tests/helpers.js';
import {
  createAcquisition,
  type FixtureRepository,
} from '@tests/mining-helpers.js';
import { temporaryDirectory } from '@tests/sampling-helpers.js';
import { describe, expect, it } from 'vitest';
import { sha256File } from '@/common/hash.js';
import { mine } from '@/modules/mining/mine.js';

const repositories: FixtureRepository[] = [
  {
    fullName: 'org/a',
    files: {
      'shell/package.json': '{}\n',
      'shell/webpack.config.js': 'new Plugin({ remotes: { h: "h" } })\n',
      'shell/src/App.js': "x\nimport('headerMf/Header');\n",
      'assets/logo.svg': '<svg/>',
    },
  },
  { fullName: 'org/b', files: { 'README.md': 'nothing here\n' } },
];

function configFor(acquisition: string) {
  return {
    acquisition,
    version: '1',
    artifactTypes: {
      'dependency-manifest': ['**/package.json'],
      'build-config': ['**/webpack.config.js'],
      source: ['**/*.js'],
      documentation: ['**/*.md'],
    },
    patterns: [
      {
        id: 'cfg-remotes',
        artifactTypes: ['build-config'],
        regex: 'remotes\\s*[:=]',
        rationale: 'Remotes declared',
      },
      {
        id: 'src-dynamic-import',
        artifactTypes: ['source'],
        regex: 'import\\([\'"][^.]',
        rationale: 'Remote import',
      },
      {
        id: 'src-iframe',
        artifactTypes: ['source'],
        regex: '<iframe',
        rationale: 'Frame embedding',
      },
    ],
    units: { artifactTypes: ['dependency-manifest', 'build-config'] },
  };
}

async function setup() {
  const acquisition = await createAcquisition(repositories);
  const output = join(temporaryDirectory(), 'mining');
  return { acquisition, output, config: configFor(acquisition.directory) };
}

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

describe('mine', () => {
  it('should write the files of each repository', async () => {
    const { output, config } = await setup();
    const result = await mine({ config, outputDir: output });
    expect(result).toEqual({ repositories: 2, patterns: 3, matches: 2 });
    expect(readdirSync(join(output, 'repos')).sort()).toEqual([
      'org__a',
      'org__b',
    ]);
    expect(parseCsv(read(output, 'repos/org__a/artifacts.csv'))).toEqual([
      ['path', 'artifact_types', 'bytes'],
      ['assets/logo.svg', '', '6'],
      ['shell/package.json', 'dependency-manifest', '3'],
      ['shell/src/App.js', 'source', '29'],
      ['shell/webpack.config.js', 'build-config;source', '36'],
    ]);
    expect(parseCsv(read(output, 'repos/org__a/matches.csv'))).toEqual([
      ['pattern', 'path', 'line', 'excerpt'],
      [
        'cfg-remotes',
        'shell/webpack.config.js',
        '1',
        'new Plugin({ remotes: { h: "h" } })',
      ],
      [
        'src-dynamic-import',
        'shell/src/App.js',
        '2',
        "import('headerMf/Header');",
      ],
    ]);
    expect(parseCsv(read(output, 'repos/org__a/units.csv'))).toEqual([
      ['directory', 'markers'],
      ['shell', 'shell/package.json;shell/webpack.config.js'],
    ]);
  });

  it('should write only the header of matches.csv for a repository without matches', async () => {
    const { output, config } = await setup();
    await mine({ config, outputDir: output });
    expect(read(output, 'repos/org__b/matches.csv')).toBe(
      'pattern,path,line,excerpt\n',
    );
    expect(parseCsv(read(output, 'repos/org__b/artifacts.csv'))).toEqual([
      ['path', 'artifact_types', 'bytes'],
      ['README.md', 'documentation', '13'],
    ]);
    expect(read(output, 'repos/org__b/units.csv')).toBe('directory,markers\n');
  });

  it('should list every pair of repository and pattern in the summary, zeros included', async () => {
    const { output, config } = await setup();
    await mine({ config, outputDir: output });
    expect(parseCsv(read(output, 'summary.csv'))).toEqual([
      ['id', 'full_name', 'pattern', 'matches', 'files'],
      ['1', 'org/a', 'cfg-remotes', '1', '1'],
      ['1', 'org/a', 'src-dynamic-import', '1', '1'],
      ['1', 'org/a', 'src-iframe', '0', '0'],
      ['2', 'org/b', 'cfg-remotes', '0', '0'],
      ['2', 'org/b', 'src-dynamic-import', '0', '0'],
      ['2', 'org/b', 'src-iframe', '0', '0'],
    ]);
  });

  it('should count distinct files apart from matches', async () => {
    const acquisition = await createAcquisition([
      { fullName: 'org/a', files: { 'a.js': "import('x')\nimport('y')\n" } },
    ]);
    const output = join(temporaryDirectory(), 'mining');
    await mine({ config: configFor(acquisition.directory), outputDir: output });
    expect(parseCsv(read(output, 'summary.csv'))[2]).toEqual([
      '1',
      'org/a',
      'src-dynamic-import',
      '2',
      '1',
    ]);
  });

  it('should record the config, its hash and the hashes of the acquisition in the manifest', async () => {
    const { acquisition, output, config } = await setup();
    await mine({ config, outputDir: output });
    const manifest = JSON.parse(read(output, 'manifest.json'));
    expect(manifest.version).toBe('1');
    expect(manifest.config).toEqual(config);
    expect(manifest.configSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.acquisition.manifestSha256).toBe(
      await sha256File(join(acquisition.directory, 'manifest.json')),
    );
    expect(manifest.acquisition.acquisitionSha256).toBe(
      await sha256File(join(acquisition.directory, 'acquisition.csv')),
    );
    expect(Object.keys(manifest.snapshots)).toEqual(['org/a', 'org/b']);
  });

  it('should produce identical CSVs when run again with the same inputs', async () => {
    const { output, config } = await setup();
    await mine({ config, outputDir: output });
    const files = [
      'summary.csv',
      'repos/org__a/artifacts.csv',
      'repos/org__a/matches.csv',
      'repos/org__a/units.csv',
      'repos/org__b/matches.csv',
    ];
    const first = files.map((file) => read(output, file));
    await mine({ config, outputDir: output });
    expect(files.map((file) => read(output, file))).toEqual(first);
    expect(existsSync(`${output}.partial`)).toBe(false);
    expect(existsSync(`${output}.previous`)).toBe(false);
  });

  it('should refuse an output made with another configuration and leave it unchanged', async () => {
    const { output, config } = await setup();
    await mine({ config, outputDir: output });
    const before = read(output, 'manifest.json');
    await expect(
      mine({ config: { ...config, version: '2' }, outputDir: output }),
    ).rejects.toThrow(/another configuration or acquisition/);
    expect(read(output, 'manifest.json')).toBe(before);
    expect(existsSync(`${output}.partial`)).toBe(false);
  });

  it('should refuse an output made from another acquisition', async () => {
    const { acquisition, output, config } = await setup();
    await mine({ config, outputDir: output });
    writeFileSync(join(acquisition.directory, 'manifest.json'), '{"schema":2}');
    await expect(mine({ config, outputDir: output })).rejects.toThrow(
      /another configuration or acquisition/,
    );
  });

  it('should refuse a non-empty directory that is not a mining output', async () => {
    const { output, config } = await setup();
    mkdirSync(output);
    writeFileSync(join(output, 'notes.txt'), 'mine');
    await expect(mine({ config, outputDir: output })).rejects.toThrow(
      /is not empty and has no manifest.json/,
    );
    expect(read(output, 'notes.txt')).toBe('mine');
  });

  it('should write nothing when the config is invalid', async () => {
    const { output, config } = await setup();
    await expect(
      mine({ config: { ...config, filters: [] }, outputDir: output }),
    ).rejects.toThrow(/unknown config field filters/);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(`${output}.partial`)).toBe(false);
  });

  it('should write nothing when a snapshot was edited', async () => {
    const { acquisition, output, config } = await setup();
    writeFileSync(
      join(acquisition.snapshot('org/b'), 'files', 'README.md'),
      'edited',
    );
    await expect(mine({ config, outputDir: output })).rejects.toThrow(
      /org\/b: acquisition.csv has content_sha256/,
    );
    expect(existsSync(output)).toBe(false);
    expect(existsSync(`${output}.partial`)).toBe(false);
  });

  it('should discard a partial output left by an interrupted run', async () => {
    const { output, config } = await setup();
    mkdirSync(`${output}.partial`, { recursive: true });
    writeFileSync(join(`${output}.partial`, 'stale.csv'), 'x');
    await mine({ config, outputDir: output });
    expect(existsSync(`${output}.partial`)).toBe(false);
    expect(existsSync(join(output, 'stale.csv'))).toBe(false);
  });

  it('should keep the previous output when the write fails', async () => {
    const { output, config } = await setup();
    await mine({ config, outputDir: output });
    const before = read(output, 'summary.csv');
    const parent = dirname(output);
    // A read-only parent makes creating `<output>.partial` fail.
    chmodSync(parent, 0o555);
    try {
      await expect(mine({ config, outputDir: output })).rejects.toThrow(
        /EACCES|EPERM/,
      );
    } finally {
      chmodSync(parent, 0o755);
    }
    expect(read(output, 'summary.csv')).toBe(before);
    expect(existsSync(`${output}.partial`)).toBe(false);
  });

  it('should not alter the acquisition', async () => {
    const { acquisition, output, config } = await setup();
    const files = ['acquisition.csv', 'manifest.json'];
    const before = files.map((file) => read(acquisition.directory, file));
    await mine({ config, outputDir: output });
    expect(files.map((file) => read(acquisition.directory, file))).toEqual(
      before,
    );
  });
});
