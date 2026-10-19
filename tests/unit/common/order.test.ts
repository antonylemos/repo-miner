import { describe, expect, it } from 'vitest';
import { compareCodePoints } from '@/common/order.js';

describe('compareCodePoints', () => {
  it('should order uppercase before lowercase, unlike localeCompare', () => {
    expect(['b', 'a', 'Z'].sort(compareCodePoints)).toEqual(['Z', 'a', 'b']);
  });

  it('should order a prefix before the longer string', () => {
    expect(compareCodePoints('a', 'a/b')).toBeLessThan(0);
  });

  it('should order astral characters after the basic plane', () => {
    expect(compareCodePoints('\u{1F600}', '～')).toBeGreaterThan(0);
  });

  it('should return zero for equal strings', () => {
    expect(compareCodePoints('src/a.js', 'src/a.js')).toBe(0);
  });
});
