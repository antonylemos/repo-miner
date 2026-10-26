import { profileConfig } from '@tests/profile-helpers.js';
import { describe, expect, it } from 'vitest';
import { parseProfileConfig } from '@/modules/profile/config.js';

const valid = () => profileConfig('data/acquisitions/a');

describe('parseProfileConfig', () => {
  it('should read a full config and compile the extractors', () => {
    const config = parseProfileConfig(valid());
    expect(config.acquisition).toBe('data/acquisitions/a');
    expect(config.version).toBe('1');
    expect(config.languages.frontend).toEqual(['TypeScript', 'CSS']);
    expect(config.annotations[1]).toEqual({
      column: 'approaches',
      name: 'approach',
      multipleLabel: 'hybrid',
    });
    expect(config.annotations[0]?.multipleLabel).toBeNull();
    const [number, list, column] = config.reviews.map(
      (review) => review.extractor,
    );
    expect(number?.kind).toBe('number');
    expect(list).toMatchObject({ kind: 'list', separator: ',' });
    expect(column).toEqual({
      kind: 'column',
      section: 'Relations',
      header: 'Type',
    });
    expect(config.derived).toEqual([
      { name: 'units', difference: ['snapshot_apps', 'unrelated_units'] },
    ]);
    expect(config.validation).toBeNull();
  });

  it('should match review expressions line by line', () => {
    const extractor = parseProfileConfig(valid()).reviews[1]?.extractor;
    const match =
      extractor?.kind === 'list'
        ? extractor.pattern.exec('x\nUnrelated: a, b.\nend')
        : null;
    expect(match?.[1]).toBe('a, b');
  });

  it('should accept the optional validation', () => {
    const config = parseProfileConfig(
      profileConfig('a', { validation: { discovery: 'data/discovery/r' } }),
    );
    expect(config.validation).toEqual({ discovery: 'data/discovery/r' });
  });

  it('should reject a missing version', () => {
    const { version: _version, ...config } = valid();
    expect(() => parseProfileConfig(config)).toThrow(/version/);
  });

  it('should reject a frontend language outside the measured ones', () => {
    const config = profileConfig('a', {
      languages: {
        measured: ['TypeScript'],
        frontend: ['Vue'],
        excludeFiles: [],
      },
    });
    expect(() => parseProfileConfig(config)).toThrow(/Vue/);
  });

  it('should reject a variable name used twice', () => {
    const config = profileConfig('a', {
      derived: [{ name: 'snapshot_apps', difference: ['a', 'b'] }],
    });
    expect(() => parseProfileConfig(config)).toThrow(/snapshot_apps/);
  });

  it.each(['domain_values', 'stars'])(
    'should reject the reserved or repeated name %s',
    (name) => {
      const config = profileConfig('a', {
        annotations: [
          { column: 'x', name: 'domain', multipleLabel: 'many' },
          { column: 'y', name },
        ],
      });
      expect(() => parseProfileConfig(config)).toThrow(name);
    },
  );

  it('should reject unknown fields', () => {
    expect(() => parseProfileConfig({ ...valid(), extra: 1 })).toThrow(/extra/);
    const config = profileConfig('a', {
      annotations: [{ column: 'x', name: 'y', other: 1 }],
    });
    expect(() => parseProfileConfig(config)).toThrow(/other/);
  });

  it('should reject an invalid regular expression', () => {
    const config = profileConfig('a', {
      reviews: [
        { name: 'n', files: 'f', statuses: ['final'], number: '(unclosed' },
      ],
    });
    expect(() => parseProfileConfig(config)).toThrow(/regular expression/);
  });

  it.each([
    ['no group', 'Apps: \\d+'],
    ['two groups', '(Apps): (\\d+)'],
  ])('should reject an expression with %s', (_label, number) => {
    const config = profileConfig('a', {
      reviews: [{ name: 'n', files: 'f', statuses: ['final'], number }],
    });
    expect(() => parseProfileConfig(config)).toThrow(/capture group/);
  });

  it('should reject a review with two extractor kinds or none', () => {
    const both = profileConfig('a', {
      reviews: [
        {
          name: 'n',
          files: 'f',
          statuses: ['final'],
          number: '(\\d+)',
          column: { section: 's', header: 'h' },
        },
      ],
    });
    expect(() => parseProfileConfig(both)).toThrow(/exactly one/);
    const none = profileConfig('a', {
      reviews: [{ name: 'n', files: 'f', statuses: ['final'] }],
    });
    expect(() => parseProfileConfig(none)).toThrow(/exactly one/);
  });

  it('should reject a list without a separator and a separator outside a list', () => {
    const noSeparator = profileConfig('a', {
      reviews: [{ name: 'n', files: 'f', statuses: ['final'], list: '(.+)' }],
    });
    expect(() => parseProfileConfig(noSeparator)).toThrow(/separator/);
    const stray = profileConfig('a', {
      reviews: [
        {
          name: 'n',
          files: 'f',
          statuses: ['final'],
          number: '(\\d+)',
          separator: ',',
        },
      ],
    });
    expect(() => parseProfileConfig(stray)).toThrow(/only with list/);
  });

  it('should reject a difference that is not a pair', () => {
    const config = profileConfig('a', {
      derived: [{ name: 'd', difference: ['a'] }],
    });
    expect(() => parseProfileConfig(config)).toThrow(/two variable names/);
  });

  it('should reject empty statuses', () => {
    const config = profileConfig('a', {
      reviews: [{ name: 'n', files: 'f', statuses: [], number: '(\\d+)' }],
    });
    expect(() => parseProfileConfig(config)).toThrow(/statuses/);
  });
});
