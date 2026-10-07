import {
  createHttpClient,
  type HttpClientOptions,
  type HttpAttemptEvent,
  isRecord,
  readJson,
  redact,
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
  queryMode: 'legacy' | 'facts' = 'legacy',
  onAttemptFinished?: (
    targets: EnrichmentTarget[],
    event: HttpAttemptEvent,
  ) => void,
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
          onAttemptFinished: (event) => onAttemptFinished?.(targets, event),
          body: JSON.stringify({
            query:
              queryMode === 'facts'
                ? REPOSITORY_QUERY.replace(
                    'defaultBranchRef { name }',
                    'defaultBranchRef { name target { oid } }',
                  )
                : REPOSITORY_QUERY,
            variables: { ids: targets.map((target) => target.nodeId) },
          }),
        },
        signal,
      );
      return normalizeNodes(
        targets,
        await readJson(response, options.token),
        options.token,
      );
    },
  };
}

function normalizeNodes(
  targets: EnrichmentTarget[],
  payload: unknown,
  token: string,
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
      redact(
        `GitHub GraphQL request failed: ${messages || 'response has no data.nodes'}`,
        token,
      ),
    );
  }
  const nodes = data.nodes;
  // Only numeric indices into this batch can reliably identify a target.
  const targetIndex = (error: Record<string, unknown>): number | null => {
    const path = error.path;
    if (
      !Array.isArray(path) ||
      path[0] !== 'nodes' ||
      !Number.isInteger(path[1]) ||
      path[1] < 0 ||
      path[1] >= targets.length
    ) {
      return null;
    }
    return path[1];
  };
  const globalErrors = errors.filter((error) => targetIndex(error) === null);

  return targets.map((target, index): EnrichmentResult => {
    const node = nodes[index];
    const nodeErrors = errors.filter((error) => targetIndex(error) === index);
    const associatedErrors = errors.filter(
      (error) => targetIndex(error) === null || targetIndex(error) === index,
    );
    if (associatedErrors.length > 0) {
      // A missing field is not proof that the repository itself is absent.
      const definitiveAbsence =
        node == null &&
        globalErrors.length === 0 &&
        nodeErrors.every(
          (error) =>
            error.type === 'NOT_FOUND' &&
            Array.isArray(error.path) &&
            error.path.length === 2,
        );
      return {
        repositoryId: target.repositoryId,
        status: definitiveAbsence ? 'not_found' : 'failed',
        data: null,
        reason: redact(
          associatedErrors
            .map((error) =>
              String(error.message ?? error.type ?? 'unknown error'),
            )
            .join('; '),
          token,
        ),
      };
    }
    if (isRecord(node) && node.databaseId === target.repositoryId) {
      return {
        repositoryId: target.repositoryId,
        status: 'ok',
        data: node,
        reason: null,
      };
    }
    return {
      repositoryId: target.repositoryId,
      status: 'failed',
      data: null,
      reason: redact(
        isRecord(node) && typeof node.databaseId === 'number'
          ? `GitHub returned databaseId ${node.databaseId} for repository ${target.repositoryId}`
          : 'GitHub returned no repository for this node id',
        token,
      ),
    };
  });
}
