import { describe, expect, it } from 'vitest';
import { isUsablePush } from '@/modules/discovery/eligibility/rules/last-push.js';

describe('isUsablePush', () => {
  it('should accept a nonempty parseable timestamp', () => {
    expect(isUsablePush('2025-01-01T00:00:00Z')).toBe(true);
  });

  it.each(['', 'not-a-date', null, undefined, 42])(
    'should reject %s',
    (value) => {
      expect(isUsablePush(value)).toBe(false);
    },
  );
});
