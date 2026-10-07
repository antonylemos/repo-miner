import { isRecord } from './records.js';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    // Array order is meaningful for queries, so only object keys are sorted.
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
