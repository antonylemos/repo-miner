import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '@tests/helpers.js';
import { createMining, inspectionConfig } from '@tests/inspection-helpers.js';
import type { FixtureRepository } from '@tests/mining-helpers.js';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { inspect } from '@/modules/inspection/inspect.js';

afterEach(removeTemporaryDirectories);

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const repositories: FixtureRepository[] = [
  {
    fullName: 'org/a',
    files: {
      'package.json': json({
        scripts: { start: 'run @scope/x' },
        dependencies: { '@scope/x': '^1.0.0', plain: 'workspace:*' },
        devDependencies: { 'lifecycle-x': '2.0.0', other: '1.0.0' },
      }),
      'webpack.config.js': 'x\nmodule.exports = { remotes: {} }\n',
      'apps/shell/package.json': json({
        dependencies: { '@scope/y': '^3.0.0' },
      }),
      'apps/shell/webpack.config.js': 'a\nb\nc\nd\nnew FederationPlugin()\n',
      'libs/legacy/package.json': '{"dependencies":{"@scope/z":"1",}}',
      'src/main.js': 'a\nb\nregisterApplication({})\n',
    },
  },
  { fullName: 'org/b', files: { 'package.json': '{}\n' } },
];

async function setup() {
  const mining = await createMining(repositories);
  const output = join(temporaryDirectory(), 'inspection');
  return {
    mining,
    output,
    config: inspectionConfig(mining.directory),
  };
}

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');
const rows = (...parts: string[]) => parseCsv(read(...parts)).slice(1);

describe('inspect', () => {
  it('should list the dependencies of each technology with their occurrences, ordered', async () => {
    const { config, output } = await setup();
    const result = await inspect({ config, outputDir: output });
    expect(result).toEqual({
      repositories: 2,
      dependencies: 4,
      invalidManifests: 1,
    });
    expect(rows(output, 'repos', 'org__a', 'dependencies.csv')).toEqual([
      [
        'apps/shell/package.json',
        '3',
        'dependencies',
        '@scope/y',
        '^3.0.0',
        'tech-a',
        'apps/shell/webpack.config.js:5',
        'webpack.config.js:2',
      ],
      [
        'package.json',
        '6',
        'dependencies',
        '@scope/x',
        '^1.0.0',
        'tech-a',
        'webpack.config.js:2',
        'apps/shell/webpack.config.js:5',
      ],
      [
        'package.json',
        '7',
        'dependencies',
        'plain',
        'workspace:*',
        'tech-a',
        'webpack.config.js:2',
        'apps/shell/webpack.config.js:5',
      ],
      [
        'package.json',
        '10',
        'devDependencies',
        'lifecycle-x',
        '2.0.0',
        'tech-b',
        'src/main.js:3',
        '',
      ],
    ]);
  });

  it('should link a workspace project without its own package.json to the package of the root', async () => {
    const mining = await createMining([
      {
        fullName: 'org/w',
        files: {
          'package.json': json({ dependencies: { plain: '1.0.0' } }),
          'projects/shell/webpack.config.js': 'remotes: {}\n',
          'apps/x/package.json': '{}\n',
          'apps/x/webpack.config.js': 'remotes: {}\n',
        },
      },
    ]);
    const output = join(temporaryDirectory(), 'inspection');
    await inspect({
      config: inspectionConfig(mining.directory),
      outputDir: output,
    });
    const [row] = rows(output, 'repos', 'org__w', 'dependencies.csv');
    expect(row?.[6]).toBe('projects/shell/webpack.config.js:1');
    expect(row?.[7]).toBe('apps/x/webpack.config.js:1');
  });

  it('should not link a file outside every package to any dependency', async () => {
    const mining = await createMining([
      {
        fullName: 'org/o',
        files: {
          'apps/a/package.json': json({ dependencies: { plain: '1.0.0' } }),
          'apps/a/webpack.config.js': 'remotes: {}\n',
          'tools/webpack.config.js': 'remotes: {}\n',
        },
      },
    ]);
    const output = join(temporaryDirectory(), 'inspection');
    await inspect({
      config: inspectionConfig(mining.directory),
      outputDir: output,
    });
    const [row] = rows(output, 'repos', 'org__o', 'dependencies.csv');
    expect(row?.[6]).toBe('apps/a/webpack.config.js:1');
    expect(row?.[7]).toBe('tools/webpack.config.js:1');
  });

  it('should list every manifest and mark the invalid one', async () => {
    const { config, output } = await setup();
    await inspect({ config, outputDir: output });
    expect(rows(output, 'repos', 'org__a', 'manifests.csv')).toEqual([
      ['apps/shell/package.json', 'ok'],
      ['libs/legacy/package.json', 'invalid'],
      ['package.json', 'ok'],
    ]);
  });

  it('should write only the header for a repository without dependencies', async () => {
    const { config, output } = await setup();
    await inspect({ config, outputDir: output });
    expect(read(output, 'repos', 'org__b', 'dependencies.csv')).toBe(
      'manifest,line,section,package,version,technology,same_package_matches,other_package_matches\n',
    );
    expect(rows(output, 'repos', 'org__b', 'manifests.csv')).toEqual([
      ['package.json', 'ok'],
    ]);
  });

  it('should summarise every repository and technology, with zeros', async () => {
    const { config, output } = await setup();
    await inspect({ config, outputDir: output });
    expect(read(output, 'summary.csv')).toBe(
      [
        'id,full_name,technology,dependencies,dependencies_with_same_package_matches',
        '1,org/a,tech-a,3,3',
        '1,org/a,tech-b,1,1',
        '2,org/b,tech-a,0,0',
        '2,org/b,tech-b,0,0',
        '',
      ].join('\n'),
    );
  });

  it('should count a dependency without a match in its package as not linked', async () => {
    const { config, output } = await setup();
    config.technologies[0]?.patterns.splice(1, 1);
    await inspect({ config, outputDir: output });
    expect(rows(output, 'summary.csv')[0]).toEqual([
      '1',
      'org/a',
      'tech-a',
      '3',
      '2',
    ]);
  });

  it('should register one dependency per technology, in the order of the config', async () => {
    const { config, output } = await setup();
    config.technologies.push({
      id: 'tech-c',
      packages: ['^@scope/x$'],
      patterns: ['src-lifecycles'],
    });
    await inspect({ config, outputDir: output });
    const found = rows(output, 'repos', 'org__a', 'dependencies.csv').filter(
      (row) => row[3] === '@scope/x',
    );
    expect(found.map((row) => row[5])).toEqual(['tech-a', 'tech-c']);
    expect(found[1]?.[6]).toBe('src/main.js:3');
  });

  it('should write the config, its hash and the mining manifest hash', async () => {
    const { config, output, mining } = await setup();
    await inspect({ config, outputDir: output });
    const manifest = JSON.parse(read(output, 'manifest.json'));
    expect(manifest).toMatchObject({
      schema: 1,
      version: '1',
      config,
      mining: { directory: mining.directory },
    });
    expect(manifest.configSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.mining.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should write identical files when run again with the same inputs', async () => {
    const { config, output } = await setup();
    await inspect({ config, outputDir: output });
    const files = ['summary.csv', 'manifest.json']
      .concat(
        ['org__a', 'org__b'].flatMap((name) =>
          ['dependencies.csv', 'manifests.csv'].map(
            (file) => `repos/${name}/${file}`,
          ),
        ),
      )
      .map((file) => [file, read(output, file)]);
    await inspect({ config, outputDir: output });
    for (const [file, content] of files)
      expect(read(output, file as string)).toBe(content);
    expect(existsSync(`${output}.partial`)).toBe(false);
    expect(existsSync(`${output}.previous`)).toBe(false);
  });

  it('should refuse an output made with another configuration and keep it', async () => {
    const { config, output } = await setup();
    await inspect({ config, outputDir: output });
    const before = read(output, 'manifest.json');
    await expect(
      inspect({ config: { ...config, version: '2' }, outputDir: output }),
    ).rejects.toThrow(/another configuration or mining.*config [0-9a-f]{64}/);
    expect(read(output, 'manifest.json')).toBe(before);
  });

  it('should refuse an output made from another mining manifest and keep it', async () => {
    const { config, output, mining } = await setup();
    await inspect({ config, outputDir: output });
    const before = read(output, 'manifest.json');
    const path = join(mining.directory, 'manifest.json');
    writeFileSync(path, `${read(path)}\n`);
    await expect(inspect({ config, outputDir: output })).rejects.toThrow(
      'another configuration or mining',
    );
    expect(read(output, 'manifest.json')).toBe(before);
  });

  it('should refuse a non-empty directory that is not an inspection output', async () => {
    const { config, output } = await setup();
    await inspect({ config, outputDir: output });
    const other = temporaryDirectory();
    writeFileSync(join(other, 'notes.txt'), 'x');
    await expect(inspect({ config, outputDir: other })).rejects.toThrow(
      'no manifest.json from a previous inspection',
    );
  });

  it('should keep the previous output and leave no partial one when reading fails', async () => {
    const { config, output, mining } = await setup();
    await inspect({ config, outputDir: output });
    const before = read(output, 'repos', 'org__a', 'dependencies.csv');
    chmodSync(
      join(mining.acquisition.snapshot('org/a'), 'files', 'package.json'),
      0o000,
    );
    await expect(inspect({ config, outputDir: output })).rejects.toThrow();
    expect(read(output, 'repos', 'org__a', 'dependencies.csv')).toBe(before);
    expect(readdirSync(join(output, '..')).sort()).toEqual(['inspection']);
  });
});
