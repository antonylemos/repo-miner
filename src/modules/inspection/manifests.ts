import { canonicalJson } from '@/common/canonical-json.js';
import { isRecord } from '@/common/records.js';

export type ManifestDependency = {
  section: string;
  name: string;
  /** The value as written; a value that is not a string is canonical JSON. */
  version: string;
  /** From 1; null when no line of the manifest declares the entry. */
  line: number | null;
};

export type ReadManifest =
  | { state: 'ok'; dependencies: ManifestDependency[] }
  | { state: 'invalid' };

export const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The first line, from `start`, that has `"key"` followed by `:`. A
 * minified manifest has everything on line 1, which is still correct.
 */
function findKey(lines: string[], key: string, start: number): number | null {
  const pattern = new RegExp(`"${escapeRegex(key)}"\\s*:`);
  for (let index = start; index < lines.length; index += 1)
    if (pattern.test(lines[index] as string)) return index;
  return null;
}

/**
 * Lists every entry of the dependency sections of a `package.json`, with the
 * line that declares it. A text that is not a JSON object is `invalid`.
 */
export function readManifest(text: string): ReadManifest {
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { state: 'invalid' };
  }
  if (!isRecord(value)) return { state: 'invalid' };
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const dependencies: ManifestDependency[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = value[section];
    if (!isRecord(entries)) continue;
    const sectionLine = findKey(lines, section, 0);
    for (const [name, version] of Object.entries(entries)) {
      const line =
        sectionLine === null ? null : findKey(lines, name, sectionLine);
      dependencies.push({
        section,
        name,
        version: typeof version === 'string' ? version : canonicalJson(version),
        line: line === null ? null : line + 1,
      });
    }
  }
  return { state: 'ok', dependencies };
}
