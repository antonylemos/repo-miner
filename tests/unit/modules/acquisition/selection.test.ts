import { describe, expect, it } from 'vitest';
import type { Annotation } from '@/modules/acquisition/annotations.js';
import {
  type ClonedRepository,
  type SelectionRules,
  selectRepositories,
} from '@/modules/acquisition/selection.js';

const rules: SelectionRules = {
  include: { classification: ['A'], status: ['final'] },
  required: ['approaches'],
};

function annotation(id: number, overrides: Partial<Annotation> = {}) {
  return {
    file: `docs/${String(id).padStart(3, '0')}.md`,
    sha256: 'x',
    id: String(id),
    fullName: `org/repo-${id}`,
    commit: String(id).repeat(40).slice(0, 40),
    classification: 'A',
    status: 'final',
    data: { approaches: ['single-spa'] },
    ...overrides,
  } satisfies Annotation;
}

function clone(id: number, rank = id): ClonedRepository {
  return {
    rank,
    id: String(id),
    fullName: `org/repo-${id}`,
    commit: String(id).repeat(40).slice(0, 40),
    branch: 'main',
  };
}

const catalogOf = (...pairs: Array<[number, string]>) =>
  new Map(pairs.map(([id, value]) => [String(id), value]));

describe('selectRepositories', () => {
  it('should select the included annotations in rank order', () => {
    const result = selectRepositories(
      [annotation(1), annotation(2)],
      [clone(1, 5), clone(2, 3)],
      catalogOf([1, 'A'], [2, 'A']),
      rules,
    );
    expect(result.problems).toEqual([]);
    expect(result.selected.map((item) => item.clone.id)).toEqual(['2', '1']);
  });

  it('should count what the classification or the state leaves out', () => {
    const result = selectRepositories(
      [
        annotation(1),
        annotation(2, { status: 'review' }),
        annotation(3, { classification: 'B' }),
      ],
      [clone(1), clone(2), clone(3)],
      catalogOf([1, 'A'], [2, 'A'], [3, 'B']),
      rules,
    );
    expect(result.problems).toEqual([]);
    expect(result.selected).toHaveLength(1);
    expect(result.unselected).toBe(2);
  });

  it('should report a duplicated id', () => {
    const result = selectRepositories(
      [annotation(1), annotation(1, { file: 'docs/dup.md' })],
      [clone(1)],
      catalogOf([1, 'A']),
      rules,
    );
    expect(result.problems).toEqual([
      expect.stringMatching(/docs\/dup\.md: id 1 is already used by docs\/001/),
    ]);
  });

  it('should report an id outside the cloned sample', () => {
    const result = selectRepositories(
      [annotation(9)],
      [clone(1)],
      catalogOf([9, 'A']),
      rules,
    );
    expect(result.problems).toEqual([
      expect.stringMatching(/id 9 is not a cloned repository/),
    ]);
  });

  it('should report a diverging full_name', () => {
    const result = selectRepositories(
      [annotation(1, { fullName: 'org/other' })],
      [clone(1)],
      catalogOf([1, 'A']),
      rules,
    );
    expect(result.problems).toEqual([
      expect.stringMatching(/full_name org\/other differs.*org\/repo-1/),
    ]);
  });

  it('should report a diverging commit with both values', () => {
    const result = selectRepositories(
      [annotation(1, { commit: 'f'.repeat(40) })],
      [clone(1)],
      catalogOf([1, 'A']),
      rules,
    );
    expect(result.problems[0]).toContain('f'.repeat(40));
    expect(result.problems[0]).toContain('1'.repeat(40));
  });

  it('should report a classification diverging from the catalog with both values', () => {
    const result = selectRepositories(
      [annotation(1, { classification: 'Non-MFE' })],
      [clone(1)],
      catalogOf([1, 'MFE-unit']),
      rules,
    );
    expect(result.problems).toEqual([
      expect.stringMatching(/Non-MFE differs from catalog\.csv \(MFE-unit\)/),
    ]);
  });

  it('should report an annotation whose catalog classification is empty', () => {
    const result = selectRepositories(
      [annotation(1)],
      [clone(1)],
      catalogOf([1, '']),
      rules,
    );
    expect(result.problems).toEqual([
      expect.stringMatching(/no classification for id 1/),
    ]);
  });

  it('should report an included catalog classification without annotation', () => {
    const result = selectRepositories(
      [],
      [clone(4)],
      catalogOf([4, 'A'], [5, 'B']),
      rules,
    );
    expect(result.problems).toEqual([
      'catalog.csv: id 4 is classified A but has no annotation',
    ]);
  });

  it.each([
    ['missing', {}],
    ['null', { approaches: null }],
    ['an empty list', { approaches: [] }],
  ])('should report a required field that is %s', (_, data) => {
    const result = selectRepositories(
      [annotation(1, { data })],
      [clone(1)],
      catalogOf([1, 'A']),
      rules,
    );
    expect(result.problems).toEqual([
      expect.stringMatching(/001\.md: required field approaches/),
    ]);
    expect(result.selected).toEqual([]);
  });

  it('should not require fields of annotations that are not selected', () => {
    const result = selectRepositories(
      [annotation(1, { status: 'draft', data: {} })],
      [clone(1)],
      catalogOf([1, 'A']),
      rules,
    );
    expect(result.problems).toEqual([]);
    expect(result.unselected).toBe(1);
  });

  it('should report three problems together', () => {
    const result = selectRepositories(
      [
        annotation(1, { commit: 'f'.repeat(40) }),
        annotation(2, { data: {} }),
        annotation(9),
      ],
      [clone(1), clone(2)],
      catalogOf([1, 'A'], [2, 'A'], [9, 'A']),
      rules,
    );
    expect(result.problems).toHaveLength(3);
  });
});
