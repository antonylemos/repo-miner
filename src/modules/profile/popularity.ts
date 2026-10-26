import { isRecord } from '@/common/records.js';
import type { CachedPage } from './api-cache.js';

function countUntil(pages: CachedPage[], field: string, until: string): number {
  const limit = Date.parse(until);
  let count = 0;
  for (const page of pages) {
    if (!Array.isArray(page.body))
      throw new Error(`${page.url}: expected a list in the response.`);
    for (const item of page.body) {
      const stamp = isRecord(item) ? item[field] : undefined;
      if (typeof stamp !== 'string' || Number.isNaN(Date.parse(stamp)))
        throw new Error(`${page.url}: an item has no valid ${field}.`);
      if (Date.parse(stamp) <= limit) count += 1;
    }
  }
  return count;
}

/** The count the `stargazers/count` endpoint returned: today's, not the one at a past instant. */
export function readStarCount(page: CachedPage): number {
  const count = isRecord(page.body) ? page.body.count : undefined;
  if (typeof count !== 'number' || !Number.isSafeInteger(count))
    throw new Error(`${page.url}: expected a count in the response.`);
  return count;
}

/** The creation instant `GET /repos/{owner}/{name}` returned. */
export function readCreatedAt(page: CachedPage): string {
  const created = isRecord(page.body) ? page.body.created_at : undefined;
  if (typeof created !== 'string' || Number.isNaN(Date.parse(created)))
    throw new Error(
      `${page.url}: expected a valid created_at in the response.`,
    );
  return created;
}

/** Forks whose `created_at` is at or before `until`. */
export function countForks(pages: CachedPage[], until: string): number {
  return countUntil(pages, 'created_at', until);
}
