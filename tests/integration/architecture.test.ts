import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectFile } from '@tests/helpers.js';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(projectFile('.'));
const IMPORT = /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*)(['"])([^'"\n]+)\1/g;

function listTypeScript(directory: string): string[] {
  return readdirSync(join(root, directory), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) =>
      relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'),
    )
    .sort();
}

function specifiers(file: string): string[] {
  const source = readFileSync(join(root, file), 'utf8');
  return [...source.matchAll(IMPORT)].map((match) => match[2] as string);
}

/** Resolves a `./`, `../`, `@/` or `@tests/` specifier to a project file, or null for packages. */
function resolveImport(file: string, specifier: string): string | null {
  let target: string;
  if (specifier.startsWith('@/')) target = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith('@tests/'))
    target = `tests/${specifier.slice('@tests/'.length)}`;
  else if (specifier.startsWith('.'))
    target = normalize(join(dirname(file), specifier))
      .split(sep)
      .join('/');
  else return null;
  return target.replace(/\.js$/, '.ts');
}

const sources = listTypeScript('src');
const tests = listTypeScript('tests');

function sourceGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of sources) {
    const targets = specifiers(file)
      .map((specifier) => resolveImport(file, specifier))
      .filter((target): target is string => target !== null);
    graph.set(file, targets);
  }
  return graph;
}

/** Strongly connected components with more than one file, or a self-import (Tarjan). */
function cycles(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  let counter = 0;
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      if (!index.has(next)) {
        visit(next);
        low.set(
          node,
          Math.min(low.get(node) as number, low.get(next) as number),
        );
      } else if (onStack.has(next)) {
        low.set(
          node,
          Math.min(low.get(node) as number, index.get(next) as number),
        );
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      const selfImport = (graph.get(node) ?? []).includes(node);
      if (component.length > 1 || selfImport) found.push(component.sort());
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return found;
}

describe('architecture', () => {
  it('should have no import cycles in src', () => {
    expect(cycles(sourceGraph())).toEqual([]);
  });

  it('should not import with ../ in src or tests', () => {
    const offenders = [...sources, ...tests].filter((file) =>
      specifiers(file).some((specifier) => specifier.startsWith('../')),
    );
    expect(offenders).toEqual([]);
  });

  it('should keep src/common free of other src files', () => {
    const offenders = sources
      .filter((file) => file.startsWith('src/common/'))
      .flatMap((file) =>
        specifiers(file)
          .map((specifier) => resolveImport(file, specifier))
          .filter(
            (target): target is string =>
              target?.startsWith('src/') === true &&
              !target.startsWith('src/common/'),
          )
          .map((target) => `${file} -> ${target}`),
      );
    expect(offenders).toEqual([]);
  });

  it('should keep model/ to types that depend only on model/', () => {
    const modelFiles = sources.filter((file) =>
      file.startsWith('src/modules/discovery/model/'),
    );
    expect(modelFiles.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of modelFiles) {
      const source = readFileSync(join(root, file), 'utf8');
      if (/^export (?!type\b|interface\b)/m.test(source))
        offenders.push(`${file}: runtime export`);
      if (/^import (?!type\b)/m.test(source))
        offenders.push(`${file}: value import`);
      for (const specifier of specifiers(file)) {
        const target = resolveImport(file, specifier);
        if (!target?.startsWith('src/modules/discovery/model/'))
          offenders.push(`${file}: imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('should keep storage/ independent of the pipeline, report and cli', () => {
    const forbidden = [
      'src/modules/discovery/pipeline/',
      'src/modules/discovery/report/',
      'src/cli/',
    ];
    const offenders = sources
      .filter((file) => file.startsWith('src/modules/discovery/storage/'))
      .flatMap((file) =>
        specifiers(file)
          .map((specifier) => resolveImport(file, specifier))
          .filter(
            (target): target is string =>
              target !== null &&
              forbidden.some((prefix) => target.startsWith(prefix)),
          )
          .map((target) => `${file} -> ${target}`),
      );
    expect(offenders).toEqual([]);
  });

  it('should not keep a file next to a folder with the same name', () => {
    const files = new Set([...sources, ...tests]);
    const offenders = [...files].filter((file) =>
      [...files].some((other) =>
        other.startsWith(`${file.replace(/\.ts$/, '')}/`),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('should keep SQL out of src/cli', () => {
    const offenders = sources.filter(
      (file) =>
        file.startsWith('src/cli/') && specifiers(file).includes('node:sqlite'),
    );
    expect(offenders).toEqual([]);
  });

  it('should mirror every unit test with the source file it covers', () => {
    const sourceFiles = new Set(sources);
    const offenders = tests
      .filter((file) => file.startsWith('tests/unit/'))
      .filter((file) => {
        const mirrored = file
          .replace(/^tests\/unit\//, 'src/')
          .replace(/\.test\.ts$/, '.ts');
        return !file.endsWith('.test.ts') || !sourceFiles.has(mirrored);
      });
    expect(offenders).toEqual([]);
  });
});
