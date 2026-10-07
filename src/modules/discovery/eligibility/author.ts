import type { AccountIdentity } from '@/modules/discovery/model/facts.js';
/** The author classification is versioned with `recent_commit`, which is its only user. */
export const AUTHOR_VERSION = 1;
export function classifyAuthor(
  account: AccountIdentity | null,
): 'human' | 'bot' | 'unknown' {
  if (
    account?.providerType === 'Bot' ||
    account?.login?.toLowerCase().endsWith('[bot]')
  )
    return 'bot';
  return account?.providerType === 'User' ? 'human' : 'unknown';
}
