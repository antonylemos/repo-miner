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
import { replaceOutput } from '@/common/output.js';
import { isRecord } from '@/common/records.js';
import { listArtifacts } from './artifacts.js';
import { parseMiningConfig } from './config.js';
import { findMatches } from './matching.js';
import { readSource } from './source.js';
import { findUnits } from './units.js';

export type MineOptions = {
  /** The parsed JSON of the config file; its SHA-256 identifies the catalog. */
  config: unknown;
  outputDir: string;
};

export type MineResult = {
  repositories: number;
  patterns: number;
  matches: number;
};

type PreviousManifest = {
  configSha256: string;
  manifestSha256: string;
  acquisitionSha256: string;
};

function readPrevious(outputDir: string): PreviousManifest | null {
  const path = join(outputDir, 'manifest.json');
  if (!existsSync(path)) {
    if (existsSync(outputDir) && readdirSync(outputDir).length > 0)
      throw new Error(
        `${outputDir} is not empty and has no manifest.json from a previous mining; use another output directory.`,
      );
    return null;
  }
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const acquisition = isRecord(value) ? value.acquisition : null;
  if (
    !isRecord(value) ||
    typeof value.configSha256 !== 'string' ||
    !isRecord(acquisition) ||
    typeof acquisition.manifestSha256 !== 'string' ||
    typeof acquisition.acquisitionSha256 !== 'string'
  )
    throw new Error(`${path} is not a mining manifest.`);
  return {
    configSha256: value.configSha256,
    manifestSha256: acquisition.manifestSha256,
    acquisitionSha256: acquisition.acquisitionSha256,
  };
}

/**
 * Locates, in every snapshot of an intact acquisition, the files of each
 * artifact type and the occurrences of each pattern of the catalog. The whole
 * output is built next to `outputDir` and replaces it at the end, so a failure
 * leaves the previous output untouched. Nothing is interpreted.
 */
export async function mine(options: MineOptions): Promise<MineResult> {
  const config = parseMiningConfig(options.config);
  const configSha256 = createHash('sha256')
    .update(canonicalJson(options.config))
    .digest('hex');
  const source = await readSource(config.acquisition);

  const previous = readPrevious(options.outputDir);
  if (
    previous !== null &&
    (previous.configSha256 !== configSha256 ||
      previous.manifestSha256 !== source.manifestSha256 ||
      previous.acquisitionSha256 !== source.acquisitionSha256)
  )
    throw new Error(
      `${options.outputDir} was made with another configuration or acquisition (manifest.json records config ${previous.configSha256}, manifest ${previous.manifestSha256} and acquisition.csv ${previous.acquisitionSha256}; this run has config ${configSha256}, manifest ${source.manifestSha256} and acquisition.csv ${source.acquisitionSha256}); use another output directory.`,
    );

  const partial = `${options.outputDir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  try {
    mkdirSync(join(partial, 'repos'), { recursive: true });
    const summary: unknown[][] = [];
    let totalMatches = 0;
    for (const repository of source.repositories) {
      const files = listArtifacts(
        repository.filesDirectory,
        config.artifactTypes,
      );
      const matches = findMatches(
        repository.filesDirectory,
        files,
        config.patterns,
      );
      const units = findUnits(files, config.units.artifactTypes);
      const directory = join(partial, 'repos', repository.directoryName);
      mkdirSync(directory);
      await writeCsv(
        join(directory, 'artifacts.csv'),
        ['path', 'artifact_types', 'bytes'],
        files.map((file) => [file.path, file.types.join(';'), file.size]),
      );
      await writeCsv(
        join(directory, 'matches.csv'),
        ['pattern', 'path', 'line', 'excerpt'],
        matches.map((match) => [
          match.pattern,
          match.path,
          match.line,
          match.excerpt,
        ]),
      );
      await writeCsv(
        join(directory, 'units.csv'),
        ['directory', 'markers'],
        units.map((unit) => [unit.directory, unit.markers.join(';')]),
      );
      for (const pattern of config.patterns) {
        const found = matches.filter((match) => match.pattern === pattern.id);
        summary.push([
          repository.id,
          repository.fullName,
          pattern.id,
          found.length,
          new Set(found.map((match) => match.path)).size,
        ]);
      }
      totalMatches += matches.length;
    }
    await writeCsv(
      join(partial, 'summary.csv'),
      ['id', 'full_name', 'pattern', 'matches', 'files'],
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
          acquisition: {
            directory: config.acquisition,
            manifestSha256: source.manifestSha256,
            acquisitionSha256: source.acquisitionSha256,
          },
          snapshots: Object.fromEntries(
            source.repositories.map((repository) => [
              repository.fullName,
              repository.contentSha256,
            ]),
          ),
        },
        null,
        2,
      )}\n`,
    );
    replaceOutput(partial, options.outputDir);
    return {
      repositories: source.repositories.length,
      patterns: config.patterns.length,
      matches: totalMatches,
    };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}
