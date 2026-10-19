import { isRecord } from '@/common/records.js';

export type Technology = {
  id: string;
  /** Compiled without the `g` flag and without implicit anchors. */
  packages: RegExp[];
  /** Ids of patterns of the mining catalog. */
  patterns: string[];
};

export type InspectionConfig = {
  /** Output directory of a `mine` run. */
  mining: string;
  version: string;
  technologies: Technology[];
};

function fail(message: string): never {
  throw new Error(`Invalid inspection config: ${message}`);
}

function object(
  value: unknown,
  field: string,
  allowed: string[],
): Record<string, unknown> {
  if (!isRecord(value)) fail(`${field} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(`unknown ${field} field ${unknown.join(', ')}`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '')
    fail(`${field} must be a non-empty string`);
  return value;
}

function nonEmptyStrings(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item === '')
  )
    fail(`${field} must be a non-empty array of non-empty strings`);
  return value as string[];
}

function parseTechnology(
  value: unknown,
  index: number,
  seen: Set<string>,
): Technology {
  const input = object(value, `technologies[${index}]`, [
    'id',
    'packages',
    'patterns',
  ]);
  const id = text(input.id, `technologies[${index}].id`);
  if (seen.has(id)) fail(`duplicate technology id ${id}`);
  seen.add(id);
  const packages = nonEmptyStrings(
    input.packages,
    `technology ${id} packages`,
  ).map((source) => {
    try {
      return new RegExp(source);
    } catch {
      return fail(`technology ${id} has the invalid package regex ${source}`);
    }
  });
  return {
    id,
    packages,
    patterns: nonEmptyStrings(input.patterns, `technology ${id} patterns`),
  };
}

export function parseInspectionConfig(input: unknown): InspectionConfig {
  const root = object(input, 'config', ['mining', 'version', 'technologies']);
  if (!Array.isArray(root.technologies) || root.technologies.length === 0)
    fail('technologies must be a non-empty array');
  const seen = new Set<string>();
  return {
    mining: text(root.mining, 'mining'),
    version: text(root.version, 'version'),
    technologies: root.technologies.map((technology, index) =>
      parseTechnology(technology, index, seen),
    ),
  };
}
