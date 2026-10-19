import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256File } from '@/common/hash.js';
import { readAnnotations, valueAt } from '@/modules/acquisition/annotations.js';

afterEach(removeTemporaryDirectories);

const COMMIT = 'a'.repeat(40);

function frontMatter(overrides: Record<string, string | null> = {}): string {
  const fields: Record<string, string | null> = {
    schema: '1',
    id: '7',
    full_name: 'org/repo',
    commit: COMMIT,
    classification: 'Categoria-X',
    approaches: '[module-federation, qiankun]',
    checklist: '{ q1: yes, q2: no }',
    frontend_units: 'null',
    annotation: '\n  method: manual\n  status: final',
    ...overrides,
  };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n\n# body\n`;
}

function write(files: Record<string, string>): string {
  const directory = temporaryDirectory();
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(directory, name), content);
  return join(directory, '[0-9]*.md');
}

describe('readAnnotations', () => {
  it('should read the structural fields and keep the whole front matter', async () => {
    const pattern = write({ '007-org__repo.md': frontMatter() });
    const { annotations, problems } = await readAnnotations(
      pattern,
      'annotation.status',
    );
    expect(problems).toEqual([]);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      id: '7',
      fullName: 'org/repo',
      commit: COMMIT,
      classification: 'Categoria-X',
      status: 'final',
    });
    expect(annotations[0]?.data.approaches).toEqual([
      'module-federation',
      'qiankun',
    ]);
    expect(annotations[0]?.data.frontend_units).toBeNull();
    expect(annotations[0]?.sha256).toBe(
      await sha256File(annotations[0]?.file as string),
    );
  });

  it('should read yes and no as strings, not booleans (YAML 1.2)', async () => {
    const pattern = write({ '007-a.md': frontMatter() });
    const { annotations } = await readAnnotations(pattern, 'annotation.status');
    expect(annotations[0]?.data.checklist).toEqual({ q1: 'yes', q2: 'no' });
  });

  it('should accept a classification no code knows', async () => {
    const pattern = write({ '007-a.md': frontMatter() });
    const { annotations } = await readAnnotations(pattern, 'annotation.status');
    expect(annotations[0]?.classification).toBe('Categoria-X');
  });

  it('should take the state from another field when configured', async () => {
    const pattern = write({ '007-a.md': frontMatter({ state: 'review' }) });
    const { annotations } = await readAnnotations(pattern, 'state');
    expect(annotations[0]?.status).toBe('review');
  });

  it('should report a file without front matter', async () => {
    const pattern = write({ '001-a.md': '# only a body\n' });
    const { annotations, problems } = await readAnnotations(
      pattern,
      'annotation.status',
    );
    expect(annotations).toEqual([]);
    expect(problems).toEqual([
      expect.stringMatching(/001-a\.md: no YAML front matter/),
    ]);
  });

  it('should report an unclosed front matter', async () => {
    const pattern = write({ '001-a.md': '---\nschema: 1\n' });
    const { problems } = await readAnnotations(pattern, 'annotation.status');
    expect(problems[0]).toMatch(/no YAML front matter/);
  });

  it('should report invalid YAML', async () => {
    const pattern = write({ '001-a.md': '---\nid: [1, 2\n---\n' });
    const { problems } = await readAnnotations(pattern, 'annotation.status');
    expect(problems[0]).toMatch(/001-a\.md: invalid YAML front matter/);
  });

  it('should report a different schema version', async () => {
    const pattern = write({ '001-a.md': frontMatter({ schema: '2' }) });
    const { problems } = await readAnnotations(pattern, 'annotation.status');
    expect(problems).toEqual([expect.stringMatching(/schema must be 1/)]);
  });

  it('should report a short commit', async () => {
    const pattern = write({ '001-a.md': frontMatter({ commit: 'abc1234' }) });
    const { problems } = await readAnnotations(pattern, 'annotation.status');
    expect(problems).toEqual([expect.stringMatching(/full 40-character SHA/)]);
  });

  it('should report every missing structural field of a file', async () => {
    const pattern = write({
      '001-a.md': frontMatter({
        id: null,
        full_name: null,
        classification: null,
        annotation: '\n  method: manual',
      }),
    });
    const { problems } = await readAnnotations(pattern, 'annotation.status');
    expect(problems).toHaveLength(4);
  });

  it('should keep reading after a bad file', async () => {
    const pattern = write({
      '001-bad.md': 'text',
      '002-good.md': frontMatter(),
    });
    const { annotations, problems } = await readAnnotations(
      pattern,
      'annotation.status',
    );
    expect(annotations).toHaveLength(1);
    expect(problems).toHaveLength(1);
  });

  it('should report a pattern that matches no file', async () => {
    const pattern = join(temporaryDirectory(), '*.md');
    const { problems } = await readAnnotations(pattern, 'annotation.status');
    expect(problems).toEqual([expect.stringMatching(/no annotation file/)]);
  });
});

describe('valueAt', () => {
  it('should follow dotted paths through maps', () => {
    const data = { annotation: { method: 'manual' }, flat: 1, none: null };
    expect(valueAt(data, 'annotation.method')).toBe('manual');
    expect(valueAt(data, 'flat')).toBe(1);
    expect(valueAt(data, 'none')).toBeNull();
    expect(valueAt(data, 'annotation.missing')).toBeUndefined();
    expect(valueAt(data, 'flat.deeper')).toBeUndefined();
  });
});
