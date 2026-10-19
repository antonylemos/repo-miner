const LANGUAGES: Record<string, string[]> = {
  TypeScript: ['.ts', '.tsx', '.mts', '.cts'],
  JavaScript: ['.js', '.jsx', '.mjs', '.cjs'],
  Vue: ['.vue'],
  Svelte: ['.svelte'],
  Astro: ['.astro'],
  HTML: ['.html', '.htm'],
  CSS: ['.css'],
  SCSS: ['.scss', '.sass'],
  Less: ['.less'],
  JSON: ['.json', '.jsonc'],
  YAML: ['.yml', '.yaml'],
  TOML: ['.toml'],
  XML: ['.xml'],
  Markdown: ['.md', '.mdx'],
  GraphQL: ['.graphql', '.gql'],
  SQL: ['.sql'],
  Shell: ['.sh', '.bash', '.zsh'],
  Python: ['.py'],
  Java: ['.java'],
  Kotlin: ['.kt', '.kts'],
  Go: ['.go'],
  Rust: ['.rs'],
  Ruby: ['.rb'],
  PHP: ['.php'],
  'C#': ['.cs'],
  C: ['.c', '.h'],
  'C++': ['.cpp', '.cc', '.cxx', '.hpp'],
  Swift: ['.swift'],
  Dart: ['.dart'],
  SVG: ['.svg'],
};

const BY_EXTENSION = new Map(
  Object.entries(LANGUAGES).flatMap(([language, extensions]) =>
    extensions.map((extension) => [extension, language] as const),
  ),
);

export const OTHER_LANGUAGE = 'Other';

export type Measures = {
  files: number;
  bytes: number;
  /** Bytes per language by file extension, largest first (ties by name). */
  languages: Array<{ language: string; bytes: number }>;
};

/** The language an extension stands for; an approximation, not a content-based detection. */
export function languageOf(path: string): string {
  const name = path.split('/').at(-1) as string;
  const dot = name.lastIndexOf('.');
  const extension = dot <= 0 ? '' : name.slice(dot).toLowerCase();
  return BY_EXTENSION.get(extension) ?? OTHER_LANGUAGE;
}

export function measure(
  files: Array<{ path: string; size: number }>,
): Measures {
  const byLanguage = new Map<string, number>();
  let bytes = 0;
  for (const file of files) {
    bytes += file.size;
    const language = languageOf(file.path);
    byLanguage.set(language, (byLanguage.get(language) ?? 0) + file.size);
  }
  const languages = [...byLanguage]
    .map(([language, size]) => ({ language, bytes: size }))
    .sort((a, b) => b.bytes - a.bytes || a.language.localeCompare(b.language));
  return { files: files.length, bytes, languages };
}

/** The CSV form: `TypeScript:30720;CSS:10240`. */
export function formatLanguages(languages: Measures['languages']): string {
  return languages.map((item) => `${item.language}:${item.bytes}`).join(';');
}
