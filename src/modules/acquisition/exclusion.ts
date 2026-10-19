import { matchesGlob } from 'node:path';

export const PRESET_NAMES = [
  'node',
  'python',
  'build-output',
  'binaries',
] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export type ExclusionRules = {
  presets: PresetName[];
  paths: string[];
  maxFileBytes: number | null;
};

/** How many leading bytes of a blob are searched for a NUL to call it binary. */
export const BINARY_SCAN_BYTES = 8192;

/** Directory sequences (`.yarn/cache` is two segments) removed with everything below them. */
const PRESET_DIRECTORIES: Record<
  Exclude<PresetName, 'binaries'>,
  string[][]
> = {
  node: [
    ['node_modules'],
    ['bower_components'],
    ['.pnpm-store'],
    ['.yarn', 'cache'],
  ],
  python: [['.venv'], ['venv'], ['__pycache__'], ['.tox']],
  'build-output': [
    ['dist'],
    ['build'],
    ['out'],
    ['.next'],
    ['.nuxt'],
    ['.output'],
    ['.angular'],
    ['.svelte-kit'],
    ['.turbo'],
    ['.cache'],
    ['coverage'],
  ],
};

const PRESET_EXTENSIONS: Partial<Record<PresetName, string[]>> = {
  python: ['.pyc'],
  binaries: [
    // images
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.bmp',
    '.ico',
    '.webp',
    '.avif',
    '.tif',
    '.tiff',
    '.psd',
    // media
    '.mp3',
    '.mp4',
    '.wav',
    '.ogg',
    '.webm',
    '.mov',
    '.avi',
    '.mkv',
    '.flac',
    '.aac',
    '.m4a',
    // fonts
    '.woff',
    '.woff2',
    '.ttf',
    '.otf',
    '.eot',
    // archives
    '.zip',
    '.tar',
    '.gz',
    '.tgz',
    '.bz2',
    '.xz',
    '.7z',
    '.rar',
    '.jar',
    '.war',
    // executables and compiled objects
    '.exe',
    '.dll',
    '.so',
    '.dylib',
    '.bin',
    '.class',
    '.o',
    '.a',
    '.wasm',
  ],
};

/** The mining of artifacts reads these, so no preset removes them. */
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'pdm.lock',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'gradle.lockfile',
  'packages.lock.json',
]);

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(path.split('/').at(-1) as string);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

function inDirectory(directories: string[], sequences: string[][]): boolean {
  return sequences.some((sequence) =>
    directories.some((_, start) =>
      sequence.every(
        (segment, offset) => directories[start + offset] === segment,
      ),
    ),
  );
}

/**
 * The reason a path is left out, decided from the tree listing alone, or null
 * when it must be read (and, with the `binaries` preset, checked for NUL).
 * Reasons are `preset:<name>`, `path:<pattern>` and `max-file-bytes`.
 */
export function exclusionReason(
  path: string,
  size: number,
  rules: ExclusionRules,
): string | null {
  const segments = path.split('/');
  const name = segments.at(-1) as string;
  const directories = segments.slice(0, -1);
  if (!isLockfile(path))
    for (const preset of PRESET_NAMES) {
      if (!rules.presets.includes(preset)) continue;
      if (
        preset !== 'binaries' &&
        inDirectory(directories, PRESET_DIRECTORIES[preset])
      )
        return `preset:${preset}`;
      if (PRESET_EXTENSIONS[preset]?.includes(extensionOf(name)))
        return `preset:${preset}`;
    }
  const pattern = rules.paths.find((candidate) => matchesGlob(path, candidate));
  if (pattern !== undefined) return `path:${pattern}`;
  if (rules.maxFileBytes !== null && size > rules.maxFileBytes)
    return 'max-file-bytes';
  return null;
}

/** Whether the leading bytes of a blob mark it binary, as git itself decides. */
export function isBinaryContent(head: Uint8Array): boolean {
  return head.subarray(0, BINARY_SCAN_BYTES).includes(0);
}

/** Whether a blob that survived `exclusionReason` still goes out for its content. */
export function binaryReason(
  path: string,
  head: Uint8Array,
  rules: ExclusionRules,
): string | null {
  return rules.presets.includes('binaries') &&
    !isLockfile(path) &&
    isBinaryContent(head)
    ? 'preset:binaries'
    : null;
}
