import { isRecord } from '@/common/records.js';
import { PRESET_NAMES, type PresetName } from './exclusion.js';

export const DEFAULT_STATUS_FIELD = 'annotation.status';

export type AcquisitionConfig = {
  /** Sample directory made by `sample` and filled by `clone`. */
  sample: string;
  include: { classification: string[]; status: string[] };
  annotations: {
    /** Glob of the annotation files, relative to the working directory. */
    files: string;
    statusField: string;
    required: string[];
    export: string[];
  };
  exclude: {
    presets: PresetName[];
    paths: string[];
    maxFileBytes: number | null;
  };
};

function rejectUnknownFields(
  input: Record<string, unknown>,
  allowed: string[],
  where: string,
): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    throw new Error(
      `Invalid acquisition config: unknown ${where} field ${unknown.join(', ')}`,
    );
}

function object(
  value: unknown,
  field: string,
  allowed: string[],
): Record<string, unknown> {
  if (!isRecord(value))
    throw new Error(`Invalid acquisition config: ${field} must be an object`);
  rejectUnknownFields(value, allowed, field);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '')
    throw new Error(
      `Invalid acquisition config: ${field} must be a non-empty string`,
    );
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item === '')
  )
    throw new Error(
      `Invalid acquisition config: ${field} must be an array of non-empty strings`,
    );
  return value as string[];
}

function parsePresets(value: unknown): PresetName[] {
  const names = stringList(value, 'exclude.presets');
  const unknown = names.filter(
    (name) => !(PRESET_NAMES as readonly string[]).includes(name),
  );
  if (unknown.length > 0)
    throw new Error(
      `Invalid acquisition config: unknown exclude preset ${unknown.join(', ')} (valid: ${PRESET_NAMES.join(', ')})`,
    );
  return names as PresetName[];
}

export function parseAcquisitionConfig(input: unknown): AcquisitionConfig {
  if (!isRecord(input))
    throw new Error('Invalid acquisition config: expected an object');
  rejectUnknownFields(
    input,
    ['sample', 'include', 'annotations', 'exclude'],
    'config',
  );
  const include = object(input.include, 'include', [
    'classification',
    'status',
  ]);
  const annotations = object(input.annotations, 'annotations', [
    'files',
    'statusField',
    'required',
    'export',
  ]);
  const exclude =
    input.exclude === undefined
      ? {}
      : object(input.exclude, 'exclude', ['presets', 'paths', 'maxFileBytes']);
  const maxFileBytes = exclude.maxFileBytes;
  if (
    maxFileBytes !== undefined &&
    (!Number.isSafeInteger(maxFileBytes) || (maxFileBytes as number) <= 0)
  )
    throw new Error(
      'Invalid acquisition config: exclude.maxFileBytes must be a positive integer',
    );
  return {
    sample: text(input.sample, 'sample'),
    include: {
      classification: stringList(
        include.classification,
        'include.classification',
      ),
      status: stringList(include.status, 'include.status'),
    },
    annotations: {
      files: text(annotations.files, 'annotations.files'),
      statusField:
        annotations.statusField === undefined
          ? DEFAULT_STATUS_FIELD
          : text(annotations.statusField, 'annotations.statusField'),
      required:
        annotations.required === undefined
          ? []
          : stringList(annotations.required, 'annotations.required'),
      export:
        annotations.export === undefined
          ? []
          : stringList(annotations.export, 'annotations.export'),
    },
    exclude: {
      presets:
        exclude.presets === undefined ? [] : parsePresets(exclude.presets),
      paths:
        exclude.paths === undefined
          ? []
          : stringList(exclude.paths, 'exclude.paths'),
      maxFileBytes: (maxFileBytes as number | undefined) ?? null,
    },
  };
}
