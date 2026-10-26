import { describe, expect, it } from 'vitest';
import {
  annotationColumns,
  readAnnotationVariables,
} from '@/modules/profile/annotations.js';

const variables = [
  { column: 'repo_type', name: 'domain', multipleLabel: null },
  { column: 'approaches', name: 'approach', multipleLabel: 'hybrid' },
];

describe('readAnnotationVariables', () => {
  it('should replace several values by the label and keep them apart', () => {
    const values = readAnnotationVariables(
      { repo_type: 'example', approaches: 'module-federation;qiankun' },
      variables,
    );
    expect(values).toEqual({
      domain: 'example',
      approach: 'hybrid',
      approach_values: 'module-federation;qiankun',
    });
  });

  it('should keep a single value', () => {
    const values = readAnnotationVariables(
      { repo_type: 'example', approaches: 'single-spa' },
      variables,
    );
    expect(values.approach).toBe('single-spa');
    expect(values.approach_values).toBe('single-spa');
  });

  it('should copy an empty cell as it is', () => {
    const values = readAnnotationVariables(
      { repo_type: '', approaches: '' },
      variables,
    );
    expect(values).toEqual({ domain: '', approach: '', approach_values: '' });
  });

  it('should copy a multi-value column without a label as it is', () => {
    const values = readAnnotationVariables({ ui: 'react;vue' }, [
      { column: 'ui', name: 'ui_technologies', multipleLabel: null },
    ]);
    expect(values.ui_technologies).toBe('react;vue');
  });

  it('should reject a column the acquisition does not have', () => {
    expect(() =>
      readAnnotationVariables({ repo_type: 'x' }, variables),
    ).toThrow(/no column approaches.*approach/);
  });
});

describe('annotationColumns', () => {
  it('should add the values column after a variable with a label', () => {
    expect(annotationColumns(variables)).toEqual([
      'domain',
      'approach',
      'approach_values',
    ]);
  });
});
