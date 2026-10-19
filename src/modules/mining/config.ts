import { isRecord } from '@/common/records.js';

export type MiningPattern = {
  id: string;
  artifactTypes: string[];
  /** Compiled without the `g` flag, so `test` keeps no state between lines. */
  regex: RegExp | null;
  rationale: string;
};

export type MiningConfig = {
  /** Directory of the acquisition to read. */
  acquisition: string;
  version: string;
  /** Artifact type id to the globs of the files that have it. */
  artifactTypes: Record<string, string[]>;
  patterns: MiningPattern[];
  units: { artifactTypes: string[] };
};

function rejectUnknownFields(
  input: Record<string, unknown>,
  allowed: string[],
  where: string,
): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    throw new Error(
      `Invalid mining config: unknown ${where} field ${unknown.join(', ')}`,
    );
}

function object(
  value: unknown,
  field: string,
  allowed: string[],
): Record<string, unknown> {
  if (!isRecord(value))
    throw new Error(`Invalid mining config: ${field} must be an object`);
  rejectUnknownFields(value, allowed, field);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '')
    throw new Error(
      `Invalid mining config: ${field} must be a non-empty string`,
    );
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item === '')
  )
    throw new Error(
      `Invalid mining config: ${field} must be an array of non-empty strings`,
    );
  return value as string[];
}

function requireTypes(
  types: string[],
  defined: Record<string, string[]>,
  field: string,
): void {
  const undefinedTypes = types.filter((type) => !Object.hasOwn(defined, type));
  if (undefinedTypes.length > 0)
    throw new Error(
      `Invalid mining config: ${field} uses the undefined artifact type ${undefinedTypes.join(', ')}`,
    );
}

function parseArtifactTypes(value: unknown): Record<string, string[]> {
  if (!isRecord(value))
    throw new Error('Invalid mining config: artifactTypes must be an object');
  return Object.fromEntries(
    Object.entries(value).map(([id, globs]) => [
      id,
      stringList(globs, `artifactTypes.${id}`),
    ]),
  );
}

function parsePattern(
  value: unknown,
  index: number,
  types: Record<string, string[]>,
  seen: Set<string>,
): MiningPattern {
  const field = `patterns[${index}]`;
  const input = object(value, field, [
    'id',
    'artifactTypes',
    'regex',
    'ignoreCase',
    'rationale',
  ]);
  const id = text(input.id, `${field}.id`);
  if (seen.has(id))
    throw new Error(`Invalid mining config: duplicate pattern id ${id}`);
  seen.add(id);
  const patternTypes = stringList(
    input.artifactTypes,
    `pattern ${id} artifactTypes`,
  );
  if (patternTypes.length === 0)
    throw new Error(
      `Invalid mining config: pattern ${id} artifactTypes must not be empty`,
    );
  requireTypes(patternTypes, types, `pattern ${id}`);
  const rationale = text(input.rationale, `pattern ${id} rationale`);
  if (input.ignoreCase !== undefined && typeof input.ignoreCase !== 'boolean')
    throw new Error(
      `Invalid mining config: pattern ${id} ignoreCase must be a boolean`,
    );
  let regex: RegExp | null = null;
  if (input.regex !== undefined) {
    const source = text(input.regex, `pattern ${id} regex`);
    try {
      regex = new RegExp(source, input.ignoreCase === true ? 'i' : '');
    } catch {
      throw new Error(
        `Invalid mining config: pattern ${id} has the invalid regex ${source}`,
      );
    }
  }
  return { id, artifactTypes: patternTypes, regex, rationale };
}

export function parseMiningConfig(input: unknown): MiningConfig {
  if (!isRecord(input))
    throw new Error('Invalid mining config: expected an object');
  const root = object(input, 'config', [
    'acquisition',
    'version',
    'artifactTypes',
    'patterns',
    'units',
  ]);
  const artifactTypes = parseArtifactTypes(root.artifactTypes);
  if (!Array.isArray(root.patterns))
    throw new Error('Invalid mining config: patterns must be an array');
  const seen = new Set<string>();
  const patterns = root.patterns.map((pattern, index) =>
    parsePattern(pattern, index, artifactTypes, seen),
  );
  const units = object(root.units, 'units', ['artifactTypes']);
  const unitTypes = stringList(units.artifactTypes, 'units.artifactTypes');
  requireTypes(unitTypes, artifactTypes, 'units');
  return {
    acquisition: text(root.acquisition, 'acquisition'),
    version: text(root.version, 'version'),
    artifactTypes,
    patterns,
    units: { artifactTypes: unitTypes },
  };
}
