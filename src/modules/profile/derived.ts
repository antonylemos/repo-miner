import type { DerivedVariable } from './config.js';

/**
 * Adds, to the values of one repository, each derived variable: the first
 * variable minus the second. A derived variable may use the ones before it. A
 * variable that is not defined or not an integer is an error; an empty value
 * gives an empty result.
 */
export function addDerived(
  values: Record<string, string>,
  derived: DerivedVariable[],
  where: string,
): Record<string, string> {
  const result = { ...values };
  for (const variable of derived) {
    const [left, right] = variable.difference.map((name) => {
      const value = result[name];
      if (value === undefined)
        throw new Error(
          `${where}: ${variable.name} uses ${name}, which is not defined before it.`,
        );
      return value;
    }) as [string, string];
    if (left === '' || right === '') {
      result[variable.name] = '';
      continue;
    }
    for (const [name, value] of [
      [variable.difference[0], left],
      [variable.difference[1], right],
    ] as const)
      if (!/^-?\d+$/.test(value))
        throw new Error(
          `${where}: ${variable.name} uses ${name}, whose value "${value}" is not a number.`,
        );
    result[variable.name] = String(Number(left) - Number(right));
  }
  return result;
}
