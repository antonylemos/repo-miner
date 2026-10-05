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
