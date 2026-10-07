import type { AccountIdentity } from './types.js';
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
