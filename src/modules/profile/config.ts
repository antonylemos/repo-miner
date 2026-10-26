import { isRecord } from '@/common/records.js';

export type AnnotationVariable = {
  /** Column of `acquisition.csv`. */
  column: string;
  name: string;
  /** Replaces a cell with two or more values; the originals go to `<name>_values`. */
  multipleLabel: string | null;
};

export type Extractor =
  | { kind: 'number'; pattern: RegExp }
  | {
      kind: 'list';
      pattern: RegExp;
      separator: string;
      /** Captured texts that stand for an empty list. */
      empty: string[];
    }
  | { kind: 'column'; section: string; header: string };

export type ReviewVariable = {
  name: string;
  /** Glob of the review files. */
  files: string;
  /** Accepted values of `annotation.status`. */
  statuses: string[];
  extractor: Extractor;
};

export type DerivedVariable = {
  name: string;
  /** The first variable minus the second. */
  difference: [string, string];
};

export type ProfileConfig = {
  /** Directory of an acquisition. */
  acquisition: string;
  version: string;
  languages: {
    measured: string[];
    frontend: string[];
    excludeFiles: string[];
  };
  annotations: AnnotationVariable[];
  reviews: ReviewVariable[];
  derived: DerivedVariable[];
  /** Output directory of a discovery run. */
  validation: { discovery: string } | null;
};

/** Columns every `profile.csv` has before the configured variables. */
export const FIXED_COLUMNS = [
  'id',
  'full_name',
  'commit_sha',
  'reference_at',
  'files',
  'excluded_files',
  'dominant_language',
  'frontend_share',
  'commits',
  'last_commit_at',
  'days_since_last_commit',
  'created_at',
  'age_days',
  'stars',
  'stars_observed_at',
  'forks',
  'contributors',
  'api_status',
];

function fail(message: string): never {
  throw new Error(`Invalid profile config: ${message}`);
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

function strings(value: unknown, field: string, minimum = 1): string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.some((item) => typeof item !== 'string' || item === '')
  )
    fail(
      minimum === 0
        ? `${field} must be an array of non-empty strings`
        : `${field} must be a non-empty array of non-empty strings`,
    );
  return value as string[];
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  return value;
}

/** Compiles a pattern that must have exactly one capture group, matched line by line. */
function pattern(source: string, field: string): RegExp {
  let regex: RegExp;
  try {
    regex = new RegExp(source, 'm');
  } catch {
    return fail(`${field} has the invalid regular expression ${source}`);
  }
  const groups = (new RegExp(`${source}|`).exec('')?.length ?? 1) - 1;
  if (groups !== 1)
    fail(
      `${field} must have exactly one capture group, ${source} has ${groups}`,
    );
  return regex;
}

function parseExtractor(
  input: Record<string, unknown>,
  name: string,
): Extractor {
  const field = `review ${name}`;
  const kinds = ['number', 'list', 'column'].filter(
    (key) => input[key] !== undefined,
  );
  if (kinds.length !== 1)
    fail(`${field} must have exactly one of number, list or column`);
  if (kinds[0] !== 'list')
    for (const key of ['separator', 'empty'])
      if (input[key] !== undefined) fail(`${field} uses ${key} only with list`);
  if (kinds[0] === 'number')
    return {
      kind: 'number',
      pattern: pattern(
        text(input.number, `${field} number`),
        `${field} number`,
      ),
    };
  if (kinds[0] === 'list')
    return {
      kind: 'list',
      pattern: pattern(text(input.list, `${field} list`), `${field} list`),
      separator: text(input.separator, `${field} separator`),
      empty:
        input.empty === undefined
          ? []
          : strings(input.empty, `${field} empty`, 0),
    };
  const column = object(input.column, `${field} column`, ['section', 'header']);
  return {
    kind: 'column',
    section: text(column.section, `${field} column section`),
    header: text(column.header, `${field} column header`),
  };
}

export function parseProfileConfig(input: unknown): ProfileConfig {
  const root = object(input, 'config', [
    'acquisition',
    'version',
    'languages',
    'annotations',
    'reviews',
    'derived',
    'validation',
  ]);
  const languages = object(root.languages, 'languages', [
    'measured',
    'frontend',
    'excludeFiles',
  ]);
  const measured = strings(languages.measured, 'languages.measured');
  const frontend = strings(languages.frontend, 'languages.frontend');
  for (const language of frontend)
    if (!measured.includes(language))
      fail(`languages.frontend lists ${language}, which is not in measured`);

  const names = new Set<string>(FIXED_COLUMNS);
  const claim = (name: string): string => {
    if (names.has(name)) fail(`duplicate variable name ${name}`);
    names.add(name);
    return name;
  };

  const annotations = list(root.annotations, 'annotations').map(
    (value, index) => {
      const field = `annotations[${index}]`;
      const item = object(value, field, ['column', 'name', 'multipleLabel']);
      const name = claim(text(item.name, `${field}.name`));
      const multipleLabel =
        item.multipleLabel === undefined
          ? null
          : text(item.multipleLabel, `${field}.multipleLabel`);
      if (multipleLabel !== null) claim(`${name}_values`);
      return {
        column: text(item.column, `${field}.column`),
        name,
        multipleLabel,
      };
    },
  );

  const reviews = list(root.reviews, 'reviews').map((value, index) => {
    const field = `reviews[${index}]`;
    const item = object(value, field, [
      'name',
      'files',
      'statuses',
      'number',
      'list',
      'separator',
      'empty',
      'column',
    ]);
    const name = claim(text(item.name, `${field}.name`));
    return {
      name,
      files: text(item.files, `${field}.files`),
      statuses: strings(item.statuses, `${field}.statuses`),
      extractor: parseExtractor(item, name),
    };
  });

  const derived = list(root.derived, 'derived').map((value, index) => {
    const field = `derived[${index}]`;
    const item = object(value, field, ['name', 'difference']);
    const name = claim(text(item.name, `${field}.name`));
    const difference = strings(item.difference, `${field}.difference`);
    if (difference.length !== 2)
      fail(`${field}.difference must have exactly two variable names`);
    return { name, difference: difference as [string, string] };
  });

  let validation: ProfileConfig['validation'] = null;
  if (root.validation !== undefined) {
    const item = object(root.validation, 'validation', ['discovery']);
    validation = { discovery: text(item.discovery, 'validation.discovery') };
  }

  return {
    acquisition: text(root.acquisition, 'acquisition'),
    version: text(root.version, 'version'),
    languages: {
      measured,
      frontend,
      excludeFiles: strings(
        languages.excludeFiles,
        'languages.excludeFiles',
        0,
      ),
    },
    annotations,
    reviews,
    derived,
    validation,
  };
}
