import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contentHash } from '@/modules/acquisition/content-hash.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('contentHash', () => {
  it('should hash the canonical list of path, mode and sha256', () => {
    const entries = [
      { path: 'a.js', mode: '100644', sha256: sha('a') },
      { path: 'bin/run', mode: '100755', sha256: sha('b') },
    ];
    const canonical = `[{"mode":"100644","path":"a.js","sha256":"${sha('a')}"},{"mode":"100755","path":"bin/run","sha256":"${sha('b')}"}]`;
    expect(contentHash(entries)).toBe(sha(canonical));
  });

  it('should not depend on the order of the entries', () => {
    const a = { path: 'a.js', mode: '100644', sha256: sha('a') };
    const b = { path: 'b.js', mode: '100644', sha256: sha('b') };
    expect(contentHash([b, a])).toBe(contentHash([a, b]));
  });

  it('should ignore extra fields of the entries', () => {
    const entry = { path: 'a.js', mode: '100644', sha256: sha('a') };
    const measured = { ...entry, size: 1 };
    expect(contentHash([measured])).toBe(contentHash([entry]));
  });

  it('should change when the mode changes', () => {
    const entry = { path: 'a.js', mode: '100644', sha256: sha('a') };
    expect(contentHash([{ ...entry, mode: '100755' }])).not.toBe(
      contentHash([entry]),
    );
  });
});
