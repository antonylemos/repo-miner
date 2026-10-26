import type { AnnotationVariable } from './config.js';

/** The columns the variables add to `profile.csv`, in the order of the config. */
export function annotationColumns(variables: AnnotationVariable[]): string[] {
  return variables.flatMap((variable) =>
    variable.multipleLabel === null
      ? [variable.name]
      : [variable.name, `${variable.name}_values`],
  );
}

/**
 * Copies the configured columns of a row of `acquisition.csv`. With a
 * `multipleLabel`, a cell of two or more `;`-separated values becomes the
 * label, and `<name>_values` keeps the cell as it was, for single values too.
 */
export function readAnnotationVariables(
  row: Record<string, string>,
  variables: AnnotationVariable[],
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of variables) {
    const cell = row[variable.column];
    if (cell === undefined)
      throw new Error(
        `acquisition.csv has no column ${variable.column}, which the variable ${variable.name} reads.`,
      );
    if (variable.multipleLabel === null) {
      values[variable.name] = cell;
      continue;
    }
    const count = cell.split(';').filter((value) => value !== '').length;
    values[variable.name] = count >= 2 ? variable.multipleLabel : cell;
    values[`${variable.name}_values`] = cell;
  }
  return values;
}
