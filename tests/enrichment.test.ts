import { describe, expect, it } from 'vitest';
import {
  createEnrichmentClient,
  ENRICHMENT_BATCH_SIZE,
} from '../src/discovery/enrichment.js';

const TOKEN = 'test-token-secret';

function makeClient(fetchFn: typeof fetch) {
  return createEnrichmentClient({
    token: TOKEN,
    fetchFn,
    sleep: async () => {},
    now: () => 0,
  });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

const targets = [
  { repositoryId: 1, nodeId: 'R_1' },
  { repositoryId: 2, nodeId: 'R_2' },
  { repositoryId: 3, nodeId: 'R_3' },
];

describe('enrichment client', () => {
  it('should post node ids and classify each node', async () => {
    let body: { query: string; variables: { ids: string[] } } | undefined;
    let url = '';
    const client = makeClient(async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return json({
        data: {
          nodes: [
            { databaseId: 1, pushedAt: '2025-02-01T00:00:00Z' },
            null,
            null,
          ],
        },
        errors: [
          {
            type: 'NOT_FOUND',
            path: ['nodes', 1],
            message: 'Could not resolve',
          },
          {
            type: 'FORBIDDEN',
            path: ['nodes', 2],
            message: 'Resource protected',
          },
        ],
      });
    });

    const results = await client.fetchRepositories(
      targets,
      new AbortController().signal,
    );

    expect(url).toBe('https://api.github.com/graphql');
    expect(body?.variables.ids).toEqual(['R_1', 'R_2', 'R_3']);
    expect(body?.query).toContain('pushedAt');
    expect(results).toEqual([
      {
        repositoryId: 1,
        status: 'ok',
        data: { databaseId: 1, pushedAt: '2025-02-01T00:00:00Z' },
        reason: null,
      },
      {
        repositoryId: 2,
        status: 'not_found',
        data: null,
        reason: 'Could not resolve',
      },
      {
        repositoryId: 3,
        status: 'failed',
        data: null,
        reason: 'Resource protected',
      },
    ]);
  });

  it('should mark a node missing from the response as failed', async () => {
    const client = makeClient(async () => json({ data: { nodes: [] } }));

    const [result] = await client.fetchRepositories(
      [targets[0]],
      new AbortController().signal,
    );

    expect(result).toMatchObject({ status: 'failed', data: null });
    expect(result.reason).toMatch(/no repository/);
  });

  it('should fail nodes with nested field errors while preserving successful siblings', async () => {
    const client = makeClient(async () =>
      json({
        data: {
          nodes: [
            { databaseId: 1, pushedAt: null },
            { databaseId: 2, pushedAt: '2025-06-01T00:00:00Z' },
            { databaseId: 3, pushedAt: null },
          ],
        },
        errors: [
          {
            type: 'INTERNAL',
            path: ['nodes', 0, 'pushedAt'],
            message: `Failed for ${TOKEN}`,
          },
        ],
      }),
    );

    const results = await client.fetchRepositories(
      targets,
      new AbortController().signal,
    );

    expect(results.map((result) => result.status)).toEqual([
      'failed',
      'ok',
      'ok',
    ]);
    expect(results[0].data).toBeNull();
    expect(results[0].reason).toContain('[REDACTED]');
    expect(results[1].data).toEqual({
      databaseId: 2,
      pushedAt: '2025-06-01T00:00:00Z',
    });
    expect(results[2].data).toEqual({ databaseId: 3, pushedAt: null });
    expect(JSON.stringify(results)).not.toContain(TOKEN);
  });

  it('should combine and redact all errors associated with a node', async () => {
    const client = makeClient(async () =>
      json({
        data: { nodes: [{ databaseId: 1, description: null }] },
        errors: [
          {
            type: 'INTERNAL',
            path: ['nodes', 0, 'description'],
            message: `Description failed for ${TOKEN}`,
          },
          {
            type: 'FORBIDDEN',
            path: ['nodes', 0, 'pushedAt'],
            message: `Push failed for ${TOKEN}`,
          },
        ],
      }),
    );

    const [result] = await client.fetchRepositories(
      [targets[0]],
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: 'failed',
      data: null,
      reason: 'Description failed for [REDACTED]; Push failed for [REDACTED]',
    });
  });

  it.each([
    {
      node: { databaseId: 1, description: null },
      path: ['nodes', 0, 'description'],
    },
    { node: null, path: ['nodes', 0, 'description'] },
    { node: { databaseId: 1 }, path: ['nodes', 0] },
  ])(
    'should not treat NOT_FOUND as definitive for $node at $path',
    async ({ node, path }) => {
      const client = makeClient(async () =>
        json({
          data: { nodes: [node] },
          errors: [
            { type: 'NOT_FOUND', path, message: `Missing for ${TOKEN}` },
          ],
        }),
      );

      const [result] = await client.fetchRepositories(
        [targets[0]],
        new AbortController().signal,
      );

      expect(result).toMatchObject({
        status: 'failed',
        data: null,
        reason: 'Missing for [REDACTED]',
      });
    },
  );

  it('should redact definitive node absence reasons', async () => {
    const client = makeClient(async () =>
      json({
        data: { nodes: [null] },
        errors: [
          {
            type: 'NOT_FOUND',
            path: ['nodes', 0],
            message: `Missing for ${TOKEN}`,
          },
        ],
      }),
    );
    const [result] = await client.fetchRepositories(
      [targets[0]],
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: 'not_found',
      data: null,
      reason: 'Missing for [REDACTED]',
    });
  });

  it.each([
    { path: undefined },
    { path: ['viewer'] },
    { path: ['nodes', 3] },
    { path: ['nodes', '0'] },
  ])(
    'should fail the batch for errors without a reliable target path $path',
    async ({ path }) => {
      const client = makeClient(async () =>
        json({
          data: {
            nodes: [{ databaseId: 1 }, { databaseId: 2 }, { databaseId: 3 }],
          },
          errors: [
            { type: 'INTERNAL', path, message: `Global failure for ${TOKEN}` },
          ],
        }),
      );
      const results = await client.fetchRepositories(
        targets,
        new AbortController().signal,
      );
      expect(results.map((result) => result.status)).toEqual([
        'failed',
        'failed',
        'failed',
      ]);
      expect(results.every((result) => result.data === null)).toBe(true);
      expect(
        results.every(
          (result) => result.reason === 'Global failure for [REDACTED]',
        ),
      ).toBe(true);
    },
  );

  it('should reject a node whose database id differs from its target', async () => {
    const client = makeClient(async () =>
      json({ data: { nodes: [{ databaseId: 2 }] } }),
    );
    const [result] = await client.fetchRepositories(
      [targets[0]],
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      repositoryId: 1,
      status: 'failed',
      data: null,
    });
    expect(result.reason).toMatch(/databaseId/);
  });

  it('should preserve legitimate null fields on a valid node without errors', async () => {
    const node = {
      databaseId: 1,
      description: null,
      pushedAt: null,
      primaryLanguage: null,
    };
    const client = makeClient(async () => json({ data: { nodes: [node] } }));
    const [result] = await client.fetchRepositories(
      [targets[0]],
      new AbortController().signal,
    );
    expect(result).toEqual({
      repositoryId: 1,
      status: 'ok',
      data: node,
      reason: null,
    });
  });

  it.each([{}, { data: null }, { data: {} }, { data: { nodes: null } }])(
    'should redact GraphQL errors when data.nodes is unavailable: %j',
    async (payload) => {
      const client = makeClient(async () =>
        json({
          ...payload,
          errors: [
            { type: 'INTERNAL', message: `Global failure for ${TOKEN}` },
          ],
        }),
      );
      await expect(
        client.fetchRepositories(targets, new AbortController().signal),
      ).rejects.toThrow(
        'GitHub GraphQL request failed: Global failure for [REDACTED]',
      );
    },
  );

  it('should throw when GraphQL returns no data', async () => {
    const client = makeClient(async () =>
      json({
        errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
      }),
    );

    await expect(
      client.fetchRepositories(targets, new AbortController().signal),
    ).rejects.toThrow(/rate limit/);
  });

  it('should refuse batches larger than the batch size', async () => {
    const client = makeClient(async () => json({ data: { nodes: [] } }));
    const tooMany = Array.from(
      { length: ENRICHMENT_BATCH_SIZE + 1 },
      (_, index) => ({ repositoryId: index, nodeId: `R_${index}` }),
    );

    await expect(
      client.fetchRepositories(tooMany, new AbortController().signal),
    ).rejects.toThrow(/at most 100/i);
  });

  it('should not leak the token in network errors', async () => {
    const client = makeClient(async () => {
      throw new Error(`socket closed for ${TOKEN}`);
    });

    const error = (await client
      .fetchRepositories(targets, new AbortController().signal)
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (caught: unknown) => caught,
      )) as Error;

    expect(error.message).not.toContain(TOKEN);
  });
});

it('legacy_query_is_unchanged', async () => {
  let query = '';
  await makeClient(async (_, init) => {
    query = JSON.parse(String(init?.body)).query;
    return json({ data: { nodes: [] } });
  }).fetchRepositories([], new AbortController().signal);
  expect(query).toContain('defaultBranchRef { name }');
  expect(query).not.toContain('target { oid }');
});
it('facts_query_returns_default_head', async () => {
  let query = '';
  const observer = [] as unknown[];
  const node = {
    databaseId: 1,
    nameWithOwner: 'renamed/repo',
    defaultBranchRef: { name: 'main', target: { oid: 'abc' } },
  };
  const client = createEnrichmentClient(
    {
      token: TOKEN,
      fetchFn: async (_, init) => {
        query = JSON.parse(String(init?.body)).query;
        return json({ data: { nodes: [node] } });
      },
      sleep: async () => {},
      now: () => 0,
    },
    'facts',
    (batch, event) => observer.push({ batch, event }),
  );
  const result = await client.fetchRepositories(
    [targets[0]],
    new AbortController().signal,
  );
  expect(query).toContain('defaultBranchRef { name target { oid } }');
  expect(result[0].data).toEqual(node);
  expect(observer).toHaveLength(1);
});
it('partial_default_ref_error_affects_only_its_node', async () => {
  const client = createEnrichmentClient(
    {
      token: TOKEN,
      fetchFn: async () =>
        json({
          data: {
            nodes: [
              { databaseId: 1, defaultBranchRef: null },
              { databaseId: 2, defaultBranchRef: null },
            ],
          },
          errors: [
            {
              path: ['nodes', 0, 'defaultBranchRef', 'target'],
              message: 'head failed',
            },
          ],
        }),
      sleep: async () => {},
      now: () => 0,
    },
    'facts',
  );
  expect(
    (
      await client.fetchRepositories(
        targets.slice(0, 2),
        new AbortController().signal,
      )
    ).map((result) => result.status),
  ).toEqual(['failed', 'ok']);
});

it('facts_observer_binds_every_retry_to_targets', async () => {
  const events: Array<{ batch: typeof targets; attempt: number }> = [];
  let calls = 0;
  const client = createEnrichmentClient(
    {
      token: TOKEN,
      fetchFn: async () =>
        ++calls === 1
          ? json({}, 500)
          : json({
              data: {
                nodes: [
                  {
                    databaseId: 999,
                    defaultBranchRef: {
                      name: 'main',
                      target: { oid: 'wrong' },
                    },
                  },
                ],
              },
            }),
      sleep: async () => {},
      now: () => 0,
    },
    'facts',
    (batch, event) => events.push({ batch, attempt: event.attempt }),
  );
  const batch = [targets[0]];
  const [result] = await client.fetchRepositories(
    batch,
    new AbortController().signal,
  );
  expect(events).toEqual([
    { batch, attempt: 1 },
    { batch, attempt: 2 },
  ]);
  expect(result).toMatchObject({ status: 'failed', data: null });
});
