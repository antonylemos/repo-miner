import { describe, expect, it } from 'vitest';
import { parseSamplingConfig } from '@/modules/sampling/config.js';

const valid = { run: 'data/discovery/round', size: 10, seed: 'seed-1' };

describe('parseSamplingConfig', () => {
  it('should accept a config without filter', () => {
    expect(parseSamplingConfig(valid)).toEqual(valid);
  });

  it('should accept a complete filter', () => {
    const filter = {
      eligibilityStatus: ['pass', 'unknown'],
      excludeReasons: ['push_unavailable'],
    };
    expect(parseSamplingConfig({ ...valid, filter })).toEqual({
      ...valid,
      filter,
    });
  });

  it.each([
    ['a missing seed', { run: valid.run, size: valid.size }, /seed/],
    ['an empty seed', { ...valid, seed: '' }, /seed/],
    ['a missing run', { size: 10, seed: 'a' }, /run/],
    ['a missing size', { run: valid.run, seed: 'a' }, /size/],
    ['a zero size', { ...valid, size: 0 }, /size/],
    ['a negative size', { ...valid, size: -3 }, /size/],
    ['a fractional size', { ...valid, size: 2.5 }, /size/],
    ['a textual size', { ...valid, size: '10' }, /size/],
    ['an unknown field', { ...valid, sizes: 3 }, /unknown config field sizes/],
    [
      'an unknown status',
      { ...valid, filter: { eligibilityStatus: ['maybe'] } },
      /unknown eligibility status maybe/,
    ],
    [
      'an unknown filter field',
      { ...valid, filter: { excludeReason: ['x'] } },
      /unknown filter field excludeReason/,
    ],
    [
      'reasons that are not strings',
      { ...valid, filter: { excludeReasons: [1] } },
      /excludeReasons/,
    ],
    ['a filter that is not an object', { ...valid, filter: [] }, /filter/],
  ])('should reject %s', (_name, input, message) => {
    expect(() => parseSamplingConfig(input)).toThrow(message);
  });

  it('should reject a config that is not an object', () => {
    expect(() => parseSamplingConfig('text')).toThrow(/expected an object/);
  });
});
