import { describe, expect, it } from 'vitest';
import { candidateScope, effectivePush } from '../src/discovery/scope.js';
import type { StoredCandidate } from '../src/discovery/types.js';

function candidate(overrides: Partial<StoredCandidate>): StoredCandidate {
  return {
    id: 1,
    nodeId: 'R_1',
    fullName: 'org/repo',
    url: 'https://github.com/org/repo',
    metadata: {},
    firstSeenAt: 'seen-at',
    metadataObservedAt: 'observed-at',
    enrichment: null,
    ...overrides,
  };
}

describe('scope', () => {
  it('should fall back to REST when successful enrichment has an invalid push', () => {
    for (const pushedAt of ['', 'not a date', null, 123]) {
      const push = effectivePush(
        candidate({
          metadata: { pushed_at: '2025-04-01T00:00:00Z' },
          enrichment: {
            status: 'ok',
            fetchedAt: 'enriched-at',
            data: { pushedAt },
            reason: null,
          },
        }),
      );
      expect(push).toEqual({
        pushedAt: '2025-04-01T00:00:00Z',
        source: 'search',
        observedAt: 'observed-at',
      });
      expect(candidateScope(push, '2025-04-01')).toBe('in_scope');
    }
  });

  it('should prefer usable enrichment even when observed before REST', () => {
    expect(
      effectivePush(
        candidate({
          metadata: { pushed_at: '2026-10-01T00:00:00Z' },
          metadataObservedAt: '2026-10-06T10:01:00Z',
          enrichment: {
            status: 'ok',
            fetchedAt: '2026-10-06T10:00:00Z',
            data: { pushedAt: '2025-04-01T00:00:00Z' },
            reason: null,
          },
        }),
      ),
    ).toEqual({
      pushedAt: '2025-04-01T00:00:00Z',
      source: 'enrichment',
      observedAt: '2026-10-06T10:00:00Z',
    });
  });

  it('should have no push provenance when both sources are invalid', () => {
    for (const value of [undefined, null, '', 'invalid', 123]) {
      expect(
        effectivePush(
          candidate({
            metadata: { pushed_at: value },
            enrichment: {
              status: 'ok',
              fetchedAt: 't',
              data: { pushedAt: value },
              reason: null,
            },
          }),
        ),
      ).toEqual({ pushedAt: null, source: null, observedAt: null });
    }
  });

  it('should prefer enrichment over search metadata', () => {
    const push = effectivePush(
      candidate({
        metadata: { pushed_at: '2023-01-01T00:00:00Z' },
        enrichment: {
          status: 'ok',
          fetchedAt: 'enriched-at',
          data: { pushedAt: '2025-05-01T00:00:00Z' },
          reason: null,
        },
      }),
    );
    expect(push).toEqual({
      pushedAt: '2025-05-01T00:00:00Z',
      source: 'enrichment',
      observedAt: 'enriched-at',
    });
    expect(candidateScope(push, '2024-01-01')).toBe('in_scope');
  });

  it('should use search metadata when there is no successful enrichment', () => {
    const push = effectivePush(
      candidate({
        metadata: { pushed_at: '2023-12-31T23:59:59Z' },
        enrichment: {
          status: 'failed',
          fetchedAt: 't',
          data: null,
          reason: 'x',
        },
      }),
    );
    expect(push).toEqual({
      pushedAt: '2023-12-31T23:59:59Z',
      source: 'search',
      observedAt: 'observed-at',
    });
    expect(candidateScope(push, '2024-01-01')).toBe('out_of_scope_temporal');
  });

  it('should include a push exactly at the threshold', () => {
    expect(
      candidateScope(
        { pushedAt: '2024-01-01T00:00:00Z', source: 'search', observedAt: 't' },
        '2024-01-01',
      ),
    ).toBe('in_scope');
  });

  it('should be unknown without a usable pushed_at', () => {
    for (const enrichment of [
      null,
      {
        status: 'not_found' as const,
        fetchedAt: 't',
        data: null,
        reason: 'gone',
      },
      {
        status: 'ok' as const,
        fetchedAt: 't',
        data: { pushedAt: null },
        reason: null,
      },
    ]) {
      const push = effectivePush(candidate({ enrichment }));
      expect(candidateScope(push, '2024-01-01')).toBe('unknown');
    }
    expect(
      candidateScope(
        { pushedAt: 'not a date', source: 'search', observedAt: 't' },
        '2024-01-01',
      ),
    ).toBe('unknown');
  });
});
