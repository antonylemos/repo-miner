import { describe, expect, it } from 'vitest';
import { classifyAuthor } from '../src/discovery/eligibility/author.js';
import { evaluateProtocol } from '../src/discovery/eligibility/evaluate.js';
import { evaluateLastPush } from '../src/discovery/eligibility/last-push.js';
import { evaluateRecentCommit } from '../src/discovery/eligibility/recent-commit.js';
import {
  candidateFacts,
  commitFact,
  completeActivityFacts,
  humanActivityRule,
} from './protocol-helpers.js';

describe('author classification', () => {
  it.each([
    [null, 'unknown'],
    [{ login: 'dependabot[bot]', providerType: 'User' }, 'bot'],
    [{ login: 'person', providerType: 'Bot' }, 'bot'],
    [{ login: 'person', providerType: 'User' }, 'human'],
    [{ login: 'person', providerType: null }, 'unknown'],
  ] as const)('classifies %j', (account, result) =>
    expect(classifyAuthor(account)).toBe(result),
  );
});
describe('recent commits', () => {
  it.each([
    'human merge',
    'human auto-merge',
    'human cherry-pick',
    'human rebase',
  ])('%s counts author despite bot committer', () =>
    expect(
      evaluateRecentCommit(
        humanActivityRule(),
        candidateFacts({ commits: [commitFact()] }),
      ),
    ).toMatchObject({
      status: 'pass',
      evidenceIds: [`commit:1:${'a'.repeat(40)}`],
    }),
  );
  it('bot author and human committer is not positive', () => {
    const c = commitFact();
    c.author = c.committer;
    c.committer = commitFact().author;
    expect(
      evaluateRecentCommit(
        humanActivityRule(),
        candidateFacts({ commits: [c] }),
      ),
    ).toMatchObject({
      status: 'unknown',
      requests: [{ kind: 'commit_history' }],
    });
  });
  it('any author accepts unknown identity', () =>
    expect(
      evaluateRecentCommit(
        humanActivityRule({ authors: 'any' }),
        candidateFacts({
          commits: [
            commitFact({ author: { name: 'x', email: 'x', account: null } }),
          ],
        }),
      ).status,
    ).toBe('pass'));
  it.each(['2025-03-31T23:59:59Z', '2026-10-06T12:00:01Z'])(
    'excludes outside interval %s',
    (committedDate) =>
      expect(
        evaluateRecentCommit(
          humanActivityRule(),
          completeActivityFacts({ commits: [commitFact({ committedDate })] }),
        ).status,
      ).toBe('fail'),
  );
  it('unknown authors remain unknown after completion without requests', () =>
    expect(
      evaluateRecentCommit(
        humanActivityRule(),
        completeActivityFacts({
          commits: [
            commitFact({
              author: {
                name: 'Human',
                email: 'human@example.com',
                account: null,
              },
            }),
          ],
        }),
      ),
    ).toMatchObject({ status: 'unknown', requests: [] }));
  it('complete empty history fails', () =>
    expect(
      evaluateRecentCommit(humanActivityRule(), completeActivityFacts()).status,
    ).toBe('fail'));
  it('does not use unrelated complete coverage', () => {
    const f = completeActivityFacts();
    if (!f.coverage[0]) throw new Error('Expected complete fixture coverage');
    f.coverage[0].request.branches = 'default';
    expect(evaluateRecentCommit(humanActivityRule(), f).status).toBe('unknown');
  });
  it.each(['repositoryId', 'since', 'until'] as const)(
    'ignores mismatched coverage %s',
    (field) => {
      const f = completeActivityFacts();
      if (!f.coverage[0]) throw new Error('Expected complete fixture coverage');
      if (field === 'repositoryId') f.coverage[0].request.repositoryId = 2;
      else f.coverage[0].request[field] = '2020-01-01T00:00:00Z';
      expect(evaluateRecentCommit(humanActivityRule(), f)).toMatchObject({
        status: 'unknown',
        requests: [{ kind: 'commit_history' }],
      });
    },
  );
  it('ignores other repository commits', () =>
    expect(
      evaluateRecentCommit(
        humanActivityRule(),
        completeActivityFacts({ commits: [commitFact({ repositoryId: 2 })] }),
      ).status,
    ).toBe('fail'));
  it('accepts observed default refs', () => {
    const ref = {
      name: 'main',
      headSha: 'a'.repeat(40),
      observedAt: '2026-10-06T12:00:00Z',
    };
    const f = completeActivityFacts({ commits: [commitFact({ refs: [ref] })] });
    if (!f.coverage[0]) throw new Error('Expected complete fixture coverage');
    f.coverage[0].request.branches = 'default';
    f.coverage[0].refs = [ref];
    expect(
      evaluateRecentCommit(humanActivityRule({ branches: 'default' }), f)
        .status,
    ).toBe('pass');
  });
  it('does not infer default membership without refs', () =>
    expect(
      evaluateRecentCommit(
        humanActivityRule({ branches: 'default' }),
        candidateFacts({ commits: [commitFact()] }),
      ).status,
    ).toBe('unknown'));
  it.each(['failed', 'limited', 'pending'] as const)(
    'never fails on %s collection',
    (state) => {
      const f = completeActivityFacts();
      if (!f.coverage[0]) throw new Error('Expected complete fixture coverage');
      f.coverage[0].state = state;
      expect(evaluateRecentCommit(humanActivityRule(), f).status).toBe(
        'unknown',
      );
    },
  );
  it('complete bot-only history fails', () => {
    const c = commitFact();
    c.author = c.committer;
    expect(
      evaluateRecentCommit(
        humanActivityRule(),
        completeActivityFacts({ commits: [c] }),
      ).status,
    ).toBe('fail');
  });
  it('default branch excludes other refs', () =>
    expect(
      evaluateRecentCommit(
        humanActivityRule({ branches: 'default' }),
        candidateFacts({
          commits: [
            commitFact({
              refs: [
                {
                  name: 'feature',
                  headSha: 'a'.repeat(40),
                  observedAt: '2026-10-06T12:00:00Z',
                },
              ],
            }),
          ],
          observations: [
            {
              id: 'meta',
              repositoryId: 1,
              source: 'enrichment',
              status: 'ok',
              observedAt: '2026-10-06T12:00:00Z',
              data: { defaultBranchRef: { name: 'main' } },
            },
          ],
        }),
      ).status,
    ).toBe('unknown'));
  it('not started is unknown without requests', () =>
    expect(
      evaluateRecentCommit(
        humanActivityRule(),
        candidateFacts({ inspectionUntil: null }),
      ),
    ).toMatchObject({
      status: 'unknown',
      reason: 'inspection_not_started',
      requests: [],
    }));
});
describe('protocol and push', () => {
  const rule = { id: 'push', type: 'last_push' as const, since: '2025-04-01' };
  it('empty protocol is not applied', () =>
    expect(
      evaluateProtocol({ version: 1, eligibility: [] }, candidateFacts()),
    ).toMatchObject({ status: 'not_applied', requests: [] }));
  it('prefers successful GraphQL push', () =>
    expect(
      evaluateLastPush(
        rule,
        candidateFacts({
          observations: [
            {
              id: 'rest',
              repositoryId: 1,
              source: 'search',
              status: 'ok',
              observedAt: '2025-01-01T00:00:00Z',
              data: { pushed_at: '2020-01-01' },
            },
            {
              id: 'gql',
              repositoryId: 1,
              source: 'enrichment',
              status: 'ok',
              observedAt: '2026-01-01T00:00:00Z',
              data: { pushedAt: '2025-04-01' },
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 'pass', evidenceIds: ['gql'] }));
  it('chooses earliest usable REST deterministically', () => {
    const observations = [
      {
        id: 'b',
        repositoryId: 1,
        source: 'search' as const,
        status: 'ok' as const,
        observedAt: '2025-01-01T00:00:00Z',
        data: { pushed_at: '2026-01-01' },
      },
      {
        id: 'a',
        repositoryId: 1,
        source: 'search' as const,
        status: 'ok' as const,
        observedAt: '2025-01-01T00:00:00Z',
        data: { pushed_at: '2020-01-01' },
      },
    ];
    expect(
      evaluateLastPush(rule, candidateFacts({ observations })),
    ).toMatchObject({ status: 'fail', evidenceIds: ['a'] });
    expect(
      evaluateLastPush(
        rule,
        candidateFacts({ observations: observations.reverse() }),
      ),
    ).toMatchObject({ status: 'fail', evidenceIds: ['a'] });
  });
  it('unusable enrichment falls back to REST', () =>
    expect(
      evaluateLastPush(
        rule,
        candidateFacts({
          observations: [
            {
              id: 'bad',
              repositoryId: 1,
              source: 'enrichment',
              status: 'ok',
              observedAt: '2025-01-01',
              data: { pushedAt: 'bad' },
            },
            {
              id: 'good',
              repositoryId: 1,
              source: 'search',
              status: 'ok',
              observedAt: '2025-01-02',
              data: { pushed_at: '2025-04-01' },
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 'pass', evidenceIds: ['good'] }));
  it('missing push requests metadata', () =>
    expect(evaluateLastPush(rule, candidateFacts())).toMatchObject({
      status: 'unknown',
      requests: [
        { kind: 'repository_metadata', repositoryId: 1, nodeId: 'repository1' },
      ],
    }));
  it('short circuits fail and drops requests', () =>
    expect(
      evaluateProtocol(
        { version: 1, eligibility: [humanActivityRule(), rule] },
        candidateFacts({
          observations: [
            {
              id: 'old',
              repositoryId: 1,
              source: 'search',
              status: 'ok',
              observedAt: '2025-01-01',
              data: { pushed_at: '2020-01-01' },
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 'fail', requests: [] }));
});
