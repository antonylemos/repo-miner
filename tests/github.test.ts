import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGitHubClient } from '../src/discovery/github.js';
import type { Subquery } from '../src/discovery/types.js';

const repositoriesFixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/repositories-page.json', import.meta.url),
    'utf8',
  ),
);
const codeFixture = JSON.parse(
  readFileSync(new URL('./fixtures/code-page.json', import.meta.url), 'utf8'),
);
const repositoryQuery: Subquery = {
  id: 'repo-query',
  queryId: 'repo-query',
  strategy: 'terminology',
  endpoint: 'repositories',
  q: 'micro frontend in:name,description,readme',
  partitionLabel: '',
};
const codeQuery: Subquery = {
  id: 'code-query',
  queryId: 'code-query',
  strategy: 'technology',
  endpoint: 'code',
  q: '"Module Federation" in:file',
  partitionLabel: '',
};

function response(
  payload: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(payload), { status, headers });
}

function makeClient(
  fetchFn: typeof fetch,
  sleeps: number[] = [],
  time = { value: 1_000_000 },
) {
  return createGitHubClient({
    token: 'test-token-secret',
    fetchFn,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason;
      sleeps.push(ms);
      time.value += ms;
    },
    now: () => time.value,
  });
}

describe('GitHub search client', () => {
  it('should normalize repository and code search responses', async () => {
    const client = makeClient(async (input) => {
      const url = new URL(String(input));
      return response(
        url.pathname.endsWith('/repositories')
          ? repositoriesFixture
          : codeFixture,
      );
    });

    const repositories = await client.search(
      repositoryQuery,
      1,
      new AbortController().signal,
    );
    const code = await client.search(
      codeQuery,
      1,
      new AbortController().signal,
    );

    expect(repositories).toMatchObject({
      totalCount: 1,
      incomplete: false,
      hasNext: false,
      hits: [
        {
          candidate: {
            id: 701,
            nodeId: 'R_kgDOAAAC_Q',
            fullName: 'example/shell',
          },
          path: null,
        },
      ],
    });
    expect(repositories.hits[0].candidate.metadata).toMatchObject({
      fork: true,
      stargazers_count: 12,
    });
    expect(code).toMatchObject({
      totalCount: 1,
      incomplete: true,
      hits: [
        {
          candidate: {
            id: 702,
            nodeId: 'R_kgDOAAAC_g',
            fullName: 'example/host',
          },
          path: 'apps/shell/root-config.ts',
        },
      ],
    });
    expect(code.hits[0].url).toContain('/blob/main/apps/shell/root-config.ts');
  });

  it('should encode the query and request one hundred results', async () => {
    let requestedUrl = '';
    let requestHeaders: Headers | undefined;
    const client = makeClient(async (input, init) => {
      requestedUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return response(repositoriesFixture);
    });

    await client.search(repositoryQuery, 3, new AbortController().signal);
    const url = new URL(requestedUrl);
    expect(url.searchParams.get('q')).toBe(repositoryQuery.q);
    expect(url.searchParams.get('per_page')).toBe('100');
    expect(url.searchParams.get('page')).toBe('3');
    expect(requestHeaders?.get('accept')).toBe('application/vnd.github+json');
    expect(requestHeaders?.get('x-github-api-version')).toBe('2026-03-10');
    expect(requestHeaders?.get('authorization')).toBe(
      'Bearer test-token-secret',
    );
  });

  it('should space repository and code searches by their minimum intervals', async () => {
    const sleeps: number[] = [];
    const client = makeClient(async (input) => {
      const url = new URL(String(input));
      return response(
        url.pathname.endsWith('/repositories')
          ? repositoriesFixture
          : codeFixture,
      );
    }, sleeps);

    await client.search(repositoryQuery, 1, new AbortController().signal);
    await client.search(repositoryQuery, 2, new AbortController().signal);
    await client.search(codeQuery, 1, new AbortController().signal);
    await client.search(codeQuery, 2, new AbortController().signal);

    expect(sleeps).toEqual([2000, 6000]);
  });

  it('should follow only a valid GitHub next-page link', async () => {
    let link =
      '<https://api.github.com/search/repositories?q=foo&page=2>; rel="next"';
    const client = makeClient(async () =>
      response(repositoriesFixture, 200, { Link: link }),
    );

    expect(
      (await client.search(repositoryQuery, 1, new AbortController().signal))
        .hasNext,
    ).toBe(true);
    link =
      '<https://api.github.com.attacker.invalid/search/repositories?page=2>; rel="next"';
    expect(
      (await client.search(repositoryQuery, 1, new AbortController().signal))
        .hasNext,
    ).toBe(false);
  });

  it('should not retry permanent authorization or validation errors', async () => {
    for (const status of [401, 403, 422]) {
      let attempts = 0;
      const client = makeClient(async () => {
        attempts += 1;
        return response({ message: 'request failed' }, status);
      });

      await expect(
        client.search(repositoryQuery, 1, new AbortController().signal),
      ).rejects.toThrow(String(status));
      expect(attempts).toBe(1);
    }
  });

  it('should respect Retry-After and rate-limit reset headers', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const client = makeClient(async () => {
      attempts += 1;
      return attempts === 1
        ? response({ message: 'secondary rate limit' }, 429, {
            'Retry-After': '4',
          })
        : response(repositoriesFixture);
    }, sleeps);

    await client.search(repositoryQuery, 1, new AbortController().signal);
    expect(sleeps).toEqual([4000]);

    const resetSleeps: number[] = [];
    attempts = 0;
    const resetClient = makeClient(async () => {
      attempts += 1;
      return attempts === 1
        ? response(repositoriesFixture, 403, {
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': '1005',
          })
        : response(repositoriesFixture);
    }, resetSleeps);
    await resetClient.search(repositoryQuery, 1, new AbortController().signal);
    expect(resetSleeps).toEqual([5000]);

    const secondarySleeps: number[] = [];
    attempts = 0;
    const secondaryClient = makeClient(async () => {
      attempts += 1;
      return attempts === 1
        ? response({ message: 'You have exceeded a secondary rate limit' }, 403)
        : response(repositoriesFixture);
    }, secondarySleeps);
    await secondaryClient.search(
      repositoryQuery,
      1,
      new AbortController().signal,
    );
    expect(secondarySleeps).toEqual([60_000]);
  });

  it('should retry a server error at most three times', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const client = makeClient(async () => {
      attempts += 1;
      return response({ message: 'unavailable' }, 503);
    }, sleeps);

    await expect(
      client.search(repositoryQuery, 1, new AbortController().signal),
    ).rejects.toThrow('503');
    expect(attempts).toBe(3);
    // The repository pacing interval can extend the first retry backoff.
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('should redact the token from network error messages', async () => {
    const client = makeClient(async () => {
      throw new Error('request failed with test-token-secret');
    });

    const error = await client
      .search(repositoryQuery, 1, new AbortController().signal)
      .then(
        () => new Error('Expected the network request to fail'),
        (value) => value as Error,
      );
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain('test-token-secret');
  });

  it('should stop an active request when its signal is aborted', async () => {
    const controller = new AbortController();
    const client = makeClient(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const pending = client.search(repositoryQuery, 1, controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });

  it('should stop a retry wait when its signal is aborted', async () => {
    const controller = new AbortController();
    let signalSleepStarted: () => void = () => {};
    const sleeping = new Promise<void>((resolve) => {
      signalSleepStarted = resolve;
    });
    const client = createGitHubClient({
      token: 'test-token-secret',
      fetchFn: async () => response({ message: 'unavailable' }, 503),
      sleep: (_ms, signal) => {
        signalSleepStarted();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      },
      now: () => 1_000_000,
    });
    const pending = client.search(repositoryQuery, 1, controller.signal);
    await sleeping;
    controller.abort(new Error('cancelled during wait'));

    await expect(pending).rejects.toThrow('cancelled during wait');
  });

  it('should count results with a single-item request', async () => {
    let requestedUrl = '';
    const client = makeClient(async (input) => {
      requestedUrl = String(input);
      return response({ ...repositoriesFixture, total_count: 4321 });
    });

    const count = await client.count(
      repositoryQuery,
      new AbortController().signal,
    );

    const url = new URL(requestedUrl);
    expect(url.searchParams.get('per_page')).toBe('1');
    expect(url.searchParams.get('page')).toBe('1');
    expect(count).toEqual({ totalCount: 4321, incomplete: false });
  });

  it('should reject a repository without node_id', async () => {
    const [item] = repositoriesFixture.items;
    const { node_id: _removed, ...withoutNodeId } = item;
    const client = makeClient(async () =>
      response({ ...repositoriesFixture, items: [withoutNodeId] }),
    );

    await expect(
      client.search(repositoryQuery, 1, new AbortController().signal),
    ).rejects.toThrow(/repository metadata/);
  });

  it('should send GraphQL-style POST requests on their own lane', async () => {
    const { createHttpClient } = await import('../src/discovery/http.js');
    const sleeps: number[] = [];
    const time = { value: 1_000_000 };
    const seen: Array<{
      method?: string;
      body?: unknown;
      type: string | null;
    }> = [];
    const http = createHttpClient({
      token: 'test-token-secret',
      fetchFn: async (_input, init) => {
        seen.push({
          method: init?.method,
          body: init?.body,
          type: new Headers(init?.headers).get('content-type'),
        });
        return response({ data: {} });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        time.value += ms;
      },
      now: () => time.value,
    });
    const request = {
      url: new URL('https://api.github.com/graphql'),
      lane: 'graphql',
      minimumIntervalMs: 1_000,
      method: 'POST' as const,
      body: '{"query":"x"}',
    };

    await http.send(request, new AbortController().signal);
    await http.send(request, new AbortController().signal);

    expect(seen[0]).toEqual({
      method: 'POST',
      body: '{"query":"x"}',
      type: 'application/json',
    });
    expect(sleeps).toEqual([1_000]);
  });
});
