import { describe, expect, it } from 'vitest';
import { parseAcquisitionConfig } from '@/modules/acquisition/config.js';

const valid = {
  sample: 'data/samples/s',
  include: { classification: ['A'], status: ['final'] },
  annotations: { files: 'docs/[0-9]*.md' },
};

describe('parseAcquisitionConfig', () => {
  it('should apply the defaults to a minimal config', () => {
    expect(parseAcquisitionConfig(valid)).toEqual({
      sample: 'data/samples/s',
      include: { classification: ['A'], status: ['final'] },
      annotations: {
        files: 'docs/[0-9]*.md',
        statusField: 'annotation.status',
        required: [],
        export: [],
      },
      exclude: { presets: [], paths: [], maxFileBytes: null },
    });
  });

  it('should read a full config', () => {
    const config = parseAcquisitionConfig({
      ...valid,
      annotations: {
        files: 'docs/*.md',
        statusField: 'state',
        required: ['approaches'],
        export: ['approaches', 'annotation.method'],
      },
      exclude: {
        presets: ['node', 'binaries'],
        paths: ['**/*.min.js'],
        maxFileBytes: 5242880,
      },
    });
    expect(config.annotations).toMatchObject({
      statusField: 'state',
      required: ['approaches'],
      export: ['approaches', 'annotation.method'],
    });
    expect(config.exclude).toEqual({
      presets: ['node', 'binaries'],
      paths: ['**/*.min.js'],
      maxFileBytes: 5242880,
    });
  });

  it('should reject an unknown preset naming it', () => {
    expect(() =>
      parseAcquisitionConfig({ ...valid, exclude: { presets: ['nodejs'] } }),
    ).toThrow(/unknown exclude preset nodejs/);
  });

  it.each([
    ['top-level', { ...valid, filters: [] }, 'config field filters'],
    [
      'include',
      { ...valid, include: { ...valid.include, tags: [] } },
      'include field tags',
    ],
    [
      'annotations',
      { ...valid, annotations: { ...valid.annotations, glob: 'x' } },
      'annotations field glob',
    ],
    ['exclude', { ...valid, exclude: { regex: [] } }, 'exclude field regex'],
  ])('should reject an unknown %s field', (_, input, message) => {
    expect(() => parseAcquisitionConfig(input)).toThrow(message);
  });

  it.each([
    ['not an object', 'x', 'expected an object'],
    ['missing sample', { ...valid, sample: undefined }, 'sample must be'],
    ['missing include', { ...valid, include: undefined }, 'include must be'],
    [
      'classification not a list',
      { ...valid, include: { classification: 'A', status: ['final'] } },
      'include.classification must be an array',
    ],
    [
      'empty status entry',
      { ...valid, include: { classification: ['A'], status: [''] } },
      'include.status must be an array',
    ],
    [
      'missing annotations',
      { ...valid, annotations: undefined },
      'annotations must be',
    ],
    [
      'required not a list',
      { ...valid, annotations: { files: 'x', required: 'a' } },
      'annotations.required',
    ],
    [
      'maxFileBytes zero',
      { ...valid, exclude: { maxFileBytes: 0 } },
      'maxFileBytes must be a positive integer',
    ],
    [
      'maxFileBytes text',
      { ...valid, exclude: { maxFileBytes: '5' } },
      'maxFileBytes must be a positive integer',
    ],
  ])('should reject %s', (_, input, message) => {
    expect(() => parseAcquisitionConfig(input)).toThrow(message);
  });
});
