import { createHash } from 'node:crypto';
import { canonicalJson } from '@/common/canonical-json.js';

export type ContentEntry = { path: string; mode: string; sha256: string };

/** SHA-256 of the canonical list of `{ path, mode, sha256 }`, ordered by path. */
export function contentHash(entries: ContentEntry[]): string {
  const ordered = entries
    .map(({ path, mode, sha256 }) => ({ path, mode, sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return createHash('sha256').update(canonicalJson(ordered)).digest('hex');
}
