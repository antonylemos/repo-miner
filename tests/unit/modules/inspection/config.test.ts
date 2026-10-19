import { describe, expect, it } from 'vitest';
import { parseInspectionConfig } from '@/modules/inspection/config.js';

const valid = {
  mining: 'data/mining/a',
  version: '1',
  technologies: [
    {
      id: 'tech-a',
      packages: ['^@scope/', '^pkg$'],
      patterns: ['cfg-one', 'cfg-two'],
    },
    { id: 'tech-b', packages: ['^other'], patterns: ['src-one'] },
  ],
};

describe('parseInspectionConfig', () => {
  it('should read a full config and compile the package expressions', () => {
    const config = parseInspectionConfig(valid);
    expect(config.mining).toBe('data/mining/a');
    expect(config.version).toBe('1');
    expect(config.technologies.map((technology) => technology.id)).toEqual([
      'tech-a',
      'tech-b',
    ]);
    expect(config.technologies[0]?.packages[0]?.test('@scope/x')).toBe(true);
    expect(config.technologies[0]?.packages[1]?.test('pkg-2')).toBe(false);
    expect(config.technologies[0]?.patterns).toEqual(['cfg-one', 'cfg-two']);
  });

  it('should keep no state between tests of the same expression', () => {
    const regex = parseInspectionConfig(valid).technologies[0]?.packages[0];
    expect(regex?.test('@scope/a')).toBe(true);
    expect(regex?.test('@scope/a')).toBe(true);
  });

  it('should accept free technology, package and pattern values', () => {
    const config = parseInspectionConfig({
      ...valid,
      technologies: [
        {
          id: 'qiankun',
          packages: ['^qiankun$'],
          patterns: ['src-lifecycles'],
        },
      ],
    });
    expect(config.technologies[0]?.id).toBe('qiankun');
  });

  it.each([
    ['a missing version', { ...valid, version: undefined }, 'version'],
    ['an empty version', { ...valid, version: '' }, 'version'],
    ['a missing mining', { ...valid, mining: undefined }, 'mining'],
    ['an unknown field', { ...valid, filters: [] }, 'filters'],
    ['no technologies', { ...valid, technologies: [] }, 'technologies'],
    [
      'an unknown technology field',
      {
        ...valid,
        technologies: [{ ...valid.technologies[0], rationale: 'x' }],
      },
      'rationale',
    ],
    [
      'an invalid package regex',
      {
        ...valid,
        technologies: [{ ...valid.technologies[0], packages: ['('] }],
      },
      'invalid package regex (',
    ],
    [
      'an empty package list',
      {
        ...valid,
        technologies: [{ ...valid.technologies[0], packages: [] }],
      },
      'packages',
    ],
    [
      'an empty pattern list',
      {
        ...valid,
        technologies: [{ ...valid.technologies[0], patterns: [] }],
      },
      'patterns',
    ],
    [
      'a repeated technology id',
      {
        ...valid,
        technologies: [valid.technologies[0], valid.technologies[0]],
      },
      'duplicate technology id tech-a',
    ],
  ])('should reject %s', (_name, input, message) => {
    expect(() => parseInspectionConfig(input)).toThrow(message);
  });

  it('should reject a config that is not an object', () => {
    expect(() => parseInspectionConfig([])).toThrow('config must be an object');
  });
});
