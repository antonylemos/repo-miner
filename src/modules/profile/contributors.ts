import { isRecord } from '@/common/records.js';
import type { CachedPage } from './api-cache.js';

export type ContributorCount = {
  /** Distinct identities among the authors, bots left out. */
  contributors: number;
  /** Commits listed, bots included. */
  commits: number;
};

function endsWithBot(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase().endsWith('[bot]');
}

/**
 * Counts the authors of the commits a listing returned. An author is the login
 * of the GitHub account, or the lowercased e-mail when the commit has none.
 */
export function countContributors(pages: CachedPage[]): ContributorCount {
  const identities = new Set<string>();
  let commits = 0;
  for (const page of pages) {
    if (!Array.isArray(page.body))
      throw new Error(`${page.url}: expected a list in the response.`);
    for (const item of page.body) {
      if (!isRecord(item))
        throw new Error(`${page.url}: a commit is not an object.`);
      commits += 1;
      const account = isRecord(item.author) ? item.author : null;
      const author =
        isRecord(item.commit) && isRecord(item.commit.author)
          ? item.commit.author
          : null;
      if (
        account?.type === 'Bot' ||
        endsWithBot(account?.login) ||
        endsWithBot(author?.name)
      )
        continue;
      if (typeof account?.login === 'string' && account.login !== '')
        identities.add(account.login.toLowerCase());
      else if (typeof author?.email === 'string' && author.email !== '')
        identities.add(author.email.toLowerCase());
    }
  }
  return { contributors: identities.size, commits };
}
