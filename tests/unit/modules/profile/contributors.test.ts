import { page } from '@tests/profile-helpers.js';
import { describe, expect, it } from 'vitest';
import { countContributors } from '@/modules/profile/contributors.js';

function commit(
  login: string | null,
  email: string,
  options: { type?: string; name?: string } = {},
) {
  return {
    author: login === null ? null : { login, type: options.type ?? 'User' },
    commit: { author: { name: options.name ?? 'Someone', email } },
  };
}

describe('countContributors', () => {
  it('should count the same account with two e-mails once', () => {
    const result = countContributors([
      page([
        commit('ana', 'ana@work.com'),
        commit('ana', '1+ana@users.noreply.github.com'),
      ]),
    ]);
    expect(result).toEqual({ contributors: 1, commits: 2 });
  });

  it('should identify an author without an account by the lowercased e-mail', () => {
    const result = countContributors([
      page([commit(null, 'Ana@Ex.com'), commit(null, 'ana@ex.com')]),
    ]);
    expect(result.contributors).toBe(1);
  });

  it('should keep an account and an e-mail apart', () => {
    const result = countContributors([
      page([commit('ana', 'a@x.com'), commit(null, 'b@x.com')]),
    ]);
    expect(result.contributors).toBe(2);
  });

  it('should leave bots out of the contributors but not of the commits', () => {
    const result = countContributors([
      page([
        commit('dependabot[bot]', 'bot@x.com', { type: 'Bot' }),
        commit('renovate[bot]', 'r@x.com'),
        commit(null, 'ci@x.com', { name: 'release[bot]' }),
        commit('ana', 'ana@x.com'),
      ]),
    ]);
    expect(result).toEqual({ contributors: 1, commits: 4 });
  });

  it('should add the pages', () => {
    const result = countContributors([
      page([commit('a', 'a@x.com')]),
      page([commit('b', 'b@x.com'), commit('a', 'a@x.com')]),
    ]);
    expect(result).toEqual({ contributors: 2, commits: 3 });
  });

  it('should reject a response that is not a list', () => {
    expect(() => countContributors([page({ message: 'x' })])).toThrow(/list/);
  });
});
