import { describe, expect, it } from 'vitest';
import { addDerived } from '@/modules/profile/derived.js';

const units = {
  name: 'units',
  difference: ['apps', 'unrelated'] as [string, string],
};

describe('addDerived', () => {
  it('should subtract the second variable from the first', () => {
    const result = addDerived({ apps: '5', unrelated: '3' }, [units], 'org/a');
    expect(result).toEqual({ apps: '5', unrelated: '3', units: '2' });
  });

  it('should allow a negative result', () => {
    expect(
      addDerived({ apps: '1', unrelated: '3' }, [units], 'org/a').units,
    ).toBe('-2');
  });

  it('should let a derived variable use an earlier one', () => {
    const result = addDerived(
      { apps: '5', unrelated: '3', other: '1' },
      [units, { name: 'rest', difference: ['units', 'other'] }],
      'org/a',
    );
    expect(result.rest).toBe('1');
  });

  it('should give an empty result when an operand is empty', () => {
    expect(
      addDerived({ apps: '', unrelated: '3' }, [units], 'org/a').units,
    ).toBe('');
  });

  it('should not change the values it was given', () => {
    const values = { apps: '5', unrelated: '3' };
    addDerived(values, [units], 'org/a');
    expect(values).toEqual({ apps: '5', unrelated: '3' });
  });

  it('should reject a variable that is not defined', () => {
    expect(() => addDerived({ apps: '5' }, [units], 'org/a')).toThrow(
      /org\/a.*units uses unrelated/,
    );
  });

  it('should reject a variable that is not a number', () => {
    expect(() =>
      addDerived({ apps: '5', unrelated: 'a;b' }, [units], 'org/a'),
    ).toThrow(/unrelated.*"a;b"/);
  });
});
