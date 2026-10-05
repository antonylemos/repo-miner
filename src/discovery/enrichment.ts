import {
  createHttpClient,
  type HttpClientOptions,
  isRecord,
  readJson,
} from './http.js';
import type {
  EnrichmentClient,
  EnrichmentResult,
  EnrichmentTarget,
} from './types.js';

const GRAPHQL_URL = 'https://api.github.com/graphql';
export const ENRICHMENT_BATCH_SIZE = 100;

const REPOSITORY_QUERY = `query RepositoryMetadata($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Repository {
      databaseId
      nameWithOwner
      url
      createdAt
      pushedAt
      isFork
      isArchived
      isTemplate
      isMirror
      diskUsage
      primaryLanguage { name }
      stargazerCount
      repositoryTopics(first: 20) { nodes { topic { name } } }
      defaultBranchRef { name }
      description
    }
  }
}`;

/** Fetches repository metadata in GraphQL batches for candidates found only through code search. */
export function createEnrichmentClient(
  options: HttpClientOptions,
): EnrichmentClient {
  const http = createHttpClient(options);
  return {
    async fetchRepositories(targets, signal) {
      if (targets.length > ENRICHMENT_BATCH_SIZE) {
        throw new Error(
          `At most ${ENRICHMENT_BATCH_SIZE} repositories can be enriched per request`,
        );
      }
      const response = await http.send(
        {
          url: new URL(GRAPHQL_URL),
          lane: 'graphql',
          minimumIntervalMs: 1_000,
          method: 'POST',
          body: JSON.stringify({
            query: REPOSITORY_QUERY,
            variables: { ids: targets.map((target) => target.nodeId) },
          }),
        },
        signal,
      );
      return normalizeNodes(targets, await readJson(response, options.token));
    },
  };
}

function normalizeNodes(
  targets: EnrichmentTarget[],
  payload: unknown,
): EnrichmentResult[] {
  if (!isRecord(payload)) {
    throw new Error('GitHub returned an invalid GraphQL response');
  }
  const errors = Array.isArray(payload.errors)
    ? payload.errors.filter(isRecord)
    : [];
  const data = payload.data;
  if (!isRecord(data) || !Array.isArray(data.nodes)) {
    const messages = errors
      .map((error) => String(error.message ?? error.type ?? 'unknown error'))
      .join('; ');
    throw new Error(
      `GitHub GraphQL request failed: ${messages || 'response has no data.nodes'}`,
    );
  }
  const nodes = data.nodes;

  return targets.map((target, index): EnrichmentResult => {
    const node = nodes[index];
    if (isRecord(node) && typeof node.databaseId === 'number') {
      return {
        repositoryId: target.repositoryId,
        status: 'ok',
        data: node,
        reason: null,
      };
    }
    // GraphQL reports per-node failures with a path such as ["nodes", 3].
    const error = errors.find(
      (entry) =>
        Array.isArray(entry.path) &&
        entry.path[0] === 'nodes' &&
        entry.path[1] === index,
    );
    const reason = error
      ? String(error.message ?? error.type)
      : 'GitHub returned no repository for this node id';
    return {
      repositoryId: target.repositoryId,
      status: error?.type === 'NOT_FOUND' ? 'not_found' : 'failed',
      data: null,
      reason,
    };
  });
}
