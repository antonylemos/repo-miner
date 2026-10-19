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
import { writeCsv } from '@/common/csv.js';
import { compareCodePoints } from '@/common/order.js';
import { replaceOutput } from '@/common/output.js';
import { isRecord } from '@/common/records.js';
import { listFiles } from '@/modules/mining/source.js';
import { parseInspectionConfig, type Technology } from './config.js';
import {
  type InspectionRepository,
  type MiningMatch,
  readInputs,
} from './inputs.js';
import { readManifest } from './manifests.js';
import { packageDirectory, packageOf } from './packages.js';

export type InspectOptions = {
  /** The parsed JSON of the config file. */
  config: unknown;
  outputDir: string;
};

export type InspectResult = {
  repositories: number;
  dependencies: number;
  invalidManifests: number;
};

type PreviousManifest = {
  configSha256: string;
  miningManifestSha256: string;
};

type Occurrence = {
  text: string;
  path: string;
  line: number;
  package: string;
};

const MANIFEST_NAME = 'package.json';

function readPrevious(outputDir: string): PreviousManifest | null {
  const path = join(outputDir, 'manifest.json');
  if (!existsSync(path)) {
    if (existsSync(outputDir) && readdirSync(outputDir).length > 0)
      throw new Error(
        `${outputDir} is not empty and has no manifest.json from a previous inspection; use another output directory.`,
      );
    return null;
  }
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const mining = isRecord(value) ? value.mining : null;
  if (
    !isRecord(value) ||
    typeof value.configSha256 !== 'string' ||
    !isRecord(mining) ||
    typeof mining.manifestSha256 !== 'string'
  )
    throw new Error(`${path} is not an inspection manifest.`);
  return {
    configSha256: value.configSha256,
    miningManifestSha256: mining.manifestSha256,
  };
}

/** Occurrences of the patterns of a technology, ordered by path and line, each place once. */
function occurrencesOf(
  matches: MiningMatch[],
  technology: Technology,
  packageDirectories: string[],
): Occurrence[] {
  const packages = new Map<string, string>();
  const found = new Map<string, Occurrence>();
  for (const match of matches) {
    if (!technology.patterns.includes(match.pattern)) continue;
    let owner = packages.get(match.path);
    if (owner === undefined) {
      owner = packageOf(match.path, packageDirectories);
      packages.set(match.path, owner);
    }
    const text = match.line === '' ? match.path : `${match.path}:${match.line}`;
    found.set(text, {
      text,
      path: match.path,
      line: match.line === '' ? 0 : Number(match.line),
      package: owner,
    });
  }
  return [...found.values()].sort(
    (a, b) => compareCodePoints(a.path, b.path) || a.line - b.line,
  );
}

type DependencyRow = {
  manifest: string;
  line: number | null;
  section: string;
  name: string;
  version: string;
  technology: string;
  samePackage: string[];
  otherPackages: string[];
};

function inspectRepository(
  repository: InspectionRepository,
  technologies: Technology[],
) {
  const paths = listFiles(repository.filesDirectory)
    .map((file) => file.path)
    .filter(
      (path) => path === MANIFEST_NAME || path.endsWith(`/${MANIFEST_NAME}`),
    );
  // Every package.json bounds a package, valid or not.
  const packageDirectories = paths.map(packageDirectory);
  const occurrences = technologies.map((technology) =>
    occurrencesOf(repository.matches, technology, packageDirectories),
  );
  const manifests: Array<{ path: string; state: string }> = [];
  const dependencies: DependencyRow[] = [];
  for (const path of paths) {
    const owner = packageDirectory(path);
    const manifest = readManifest(
      readFileSync(join(repository.filesDirectory, path), 'utf8'),
    );
    manifests.push({ path, state: manifest.state });
    if (manifest.state === 'invalid') continue;
    for (const dependency of manifest.dependencies)
      for (const [index, technology] of technologies.entries()) {
        if (!technology.packages.some((regex) => regex.test(dependency.name)))
          continue;
        // A file outside every package is in the package of no manifest.
        const inPackage = (occurrence: Occurrence) =>
          occurrence.package === owner;
        const found = occurrences[index] as Occurrence[];
        dependencies.push({
          manifest: path,
          line: dependency.line,
          section: dependency.section,
          name: dependency.name,
          version: dependency.version,
          technology: technology.id,
          samePackage: found.filter(inPackage).map(({ text }) => text),
          otherPackages: found
            .filter((occurrence) => !inPackage(occurrence))
            .map(({ text }) => text),
        });
      }
  }
  const order = new Map(technologies.map(({ id }, index) => [id, index]));
  dependencies.sort(
    (a, b) =>
      compareCodePoints(a.manifest, b.manifest) ||
      compareCodePoints(a.section, b.section) ||
      compareCodePoints(a.name, b.name) ||
      (order.get(a.technology) as number) - (order.get(b.technology) as number),
  );
  manifests.sort((a, b) => compareCodePoints(a.path, b.path));
  return { manifests, dependencies };
}

/**
 * Reads the `package.json` of every snapshot mined by `mine` and lists the
 * dependencies of the declared technologies with their section, version and
 * line, linked to the mining occurrences in the same package and in other packages.
 * The whole output is built next to `outputDir` and replaces it at the end, so
 * a failure leaves the previous output untouched. Nothing is interpreted.
 */
export async function inspect(options: InspectOptions): Promise<InspectResult> {
  const config = parseInspectionConfig(options.config);
  const configSha256 = createHash('sha256')
    .update(canonicalJson(options.config))
    .digest('hex');
  const inputs = await readInputs(config);

  const previous = readPrevious(options.outputDir);
  if (
    previous !== null &&
    (previous.configSha256 !== configSha256 ||
      previous.miningManifestSha256 !== inputs.miningManifestSha256)
  )
    throw new Error(
      `${options.outputDir} was made with another configuration or mining (manifest.json records config ${previous.configSha256} and mining manifest ${previous.miningManifestSha256}; this run has config ${configSha256} and mining manifest ${inputs.miningManifestSha256}); use another output directory.`,
    );

  const partial = `${options.outputDir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  try {
    mkdirSync(join(partial, 'repos'), { recursive: true });
    const summary: unknown[][] = [];
    let totalDependencies = 0;
    let invalidManifests = 0;
    for (const repository of inputs.repositories) {
      const { manifests, dependencies } = inspectRepository(
        repository,
        config.technologies,
      );
      const directory = join(partial, 'repos', repository.directoryName);
      mkdirSync(directory);
      await writeCsv(
        join(directory, 'dependencies.csv'),
        [
          'manifest',
          'line',
          'section',
          'package',
          'version',
          'technology',
          'same_package_matches',
          'other_package_matches',
        ],
        dependencies.map((row) => [
          row.manifest,
          row.line,
          row.section,
          row.name,
          row.version,
          row.technology,
          row.samePackage.join(';'),
          row.otherPackages.join(';'),
        ]),
      );
      await writeCsv(
        join(directory, 'manifests.csv'),
        ['manifest', 'state'],
        manifests.map((manifest) => [manifest.path, manifest.state]),
      );
      for (const technology of config.technologies) {
        const found = dependencies.filter(
          (row) => row.technology === technology.id,
        );
        summary.push([
          repository.id,
          repository.fullName,
          technology.id,
          found.length,
          found.filter((row) => row.samePackage.length > 0).length,
        ]);
      }
      totalDependencies += dependencies.length;
      invalidManifests += manifests.filter(
        (manifest) => manifest.state === 'invalid',
      ).length;
    }
    await writeCsv(
      join(partial, 'summary.csv'),
      [
        'id',
        'full_name',
        'technology',
        'dependencies',
        'dependencies_with_same_package_matches',
      ],
      summary,
    );
    writeFileSync(
      join(partial, 'manifest.json'),
      `${JSON.stringify(
        {
          schema: 1,
          version: config.version,
          configSha256,
          config: options.config,
          mining: {
            directory: inputs.miningDirectory,
            manifestSha256: inputs.miningManifestSha256,
          },
        },
        null,
        2,
      )}\n`,
    );
    replaceOutput(partial, options.outputDir);
    return {
      repositories: inputs.repositories.length,
      dependencies: totalDependencies,
      invalidManifests,
    };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}
