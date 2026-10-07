import { DEFAULT_COLLECTION_LIMITS } from '../src/discovery/collectors/types.js';
import type {
  CandidateFacts,
  CommitFact,
  EligibilityRule,
  RecentCommitRule,
} from '../src/discovery/eligibility/types.js';
import { openStore } from '../src/discovery/storage/store.js';
import { prepareSearchPlan } from '../src/discovery/study-config.js';
import type { Query, SearchHit, SearchPage } from '../src/discovery/types.js';

export function query(overrides: Partial<Query> & Pick<Query, 'id'>): Query {
  return {
    strategy: 'terminology',
    endpoint: 'repositories',
    q: overrides.id,
    rationale: 'test query',
    ...overrides,
  };
}

/** Builds a hit; metadata defaults to an in-scope repository-search record. */
export function hit(
  id: number,
  options: { path?: string | null; metadata?: Record<string, unknown> } = {},
): SearchHit {
  const fullName = `org/repo-${id}`;
  const path = options.path ?? null;
  return {
    candidate: {
      id,
      nodeId: `R_${id}`,
      fullName,
      url: `https://github.com/${fullName}`,
      metadata: options.metadata ?? { pushed_at: '2025-01-01T00:00:00Z' },
    },
    path,
    url: path
      ? `https://github.com/${fullName}/blob/main/${path}`
      : `https://github.com/${fullName}`,
  };
}

export function page(
  hits: SearchHit[],
  options: {
    hasNext?: boolean;
    totalCount?: number;
    incomplete?: boolean;
  } = {},
): SearchPage {
  return {
    hits,
    hasNext: options.hasNext ?? false,
    totalCount: options.totalCount ?? hits.length,
    incomplete: options.incomplete ?? false,
  };
}

/** Minimal RFC 4180 parser for asserting exported CSV files. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function restCommitPayload() {
  return {
    sha: 'a'.repeat(40),
    commit: {
      author: { name: 'Human', email: null, date: '2025-04-01T02:00:00+02:00' },
      committer: { name: 'Bot', email: null, date: '2025-04-01T00:00:00Z' },
    },
    author: { login: 'human', type: 'User' },
    committer: { login: 'bot', type: 'Bot' },
  };
}
export function humanActivityRule(
  overrides: Partial<RecentCommitRule> = {},
): RecentCommitRule {
  return {
    id: 'human_activity',
    type: 'recent_commit',
    since: '2025-04-01',
    dateField: 'committedDate',
    branches: 'all',
    authors: 'human',
    ...overrides,
  };
}
export function commitFact(overrides: Partial<CommitFact> = {}): CommitFact {
  return {
    repositoryId: 1,
    sha: 'a'.repeat(40),
    authoredDate: '2025-03-01T00:00:00Z',
    committedDate: '2025-04-01T00:00:00Z',
    author: {
      name: 'Human',
      email: null,
      account: { login: 'human', providerType: 'User' },
    },
    committer: {
      name: 'Bot',
      email: null,
      account: { login: 'merge[bot]', providerType: 'Bot' },
    },
    observedAt: '2026-10-06T12:00:00Z',
    ...overrides,
  };
}
export function candidateFacts(
  overrides: Partial<CandidateFacts> = {},
): CandidateFacts {
  return {
    revision: 1,
    candidate: {
      id: 1,
      nodeId: 'repository1',
      fullName: 'owner/repo',
      url: 'https://github.com/owner/repo',
      metadata: {},
    },
    inspectionUntil: '2026-10-06T12:00:00Z',
    commits: [],
    observations: [],
    coverage: [],
    ...overrides,
  };
}
export function completeActivityFacts(
  overrides: Partial<CandidateFacts> = {},
): CandidateFacts {
  const facts = candidateFacts(overrides);
  return {
    ...facts,
    coverage: [
      {
        request: {
          kind: 'commit_history',
          repositoryId: 1,
          since: '2025-04-01T00:00:00Z',
          until: facts.inspectionUntil ?? '2026-10-06T12:00:00Z',
          branches: 'all',
        },
        refs: [],
        pages: 1,
        state: 'complete',
        reason: null,
        evidenceIds: ['page:1'],
      },
    ],
    ...overrides,
  };
}

/** Deterministic REST facts for the controlled integration pilot. */
export function syntheticCommit(
  seed: number,
  options: {
    author?: 'human' | 'bot' | 'unknown' | 'conflicting';
    committedDate?: string;
    sha?: string;
    merge?: boolean;
  } = {},
) {
  const author = options.author ?? 'human';
  return {
    sha: options.sha ?? seed.toString(16).padStart(40, '0'),
    commit: {
      message: options.merge ? 'Automatically merge approved change' : 'Change',
      author: {
        name:
          author === 'unknown'
            ? null
            : author === 'human'
              ? 'Person'
              : 'robot[bot]',
        email: null,
        date: '2024-01-01T00:00:00Z',
      },
      committer: {
        name: author === 'human' ? 'merge[bot]' : 'Person',
        email: null,
        date: options.committedDate ?? '2025-04-01T00:00:00Z',
      },
    },
    author:
      author === 'unknown'
        ? null
        : {
            login: author === 'human' ? 'person' : 'robot[bot]',
            type: author === 'bot' ? 'Bot' : 'User',
          },
    committer:
      author === 'human'
        ? { login: 'merge[bot]', type: 'Bot' }
        : { login: 'person', type: 'User' },
    parents: options.merge
      ? [{ sha: 'a'.repeat(40) }, { sha: 'b'.repeat(40) }]
      : [],
  };
}
export function syntheticRepositories() {
  return Array.from({ length: 12 }, (_, index) => {
    const id = index + 1;
    return {
      id,
      node_id: `R_${id}`,
      full_name: `pilot/r${id}`,
      html_url: `https://github.com/pilot/r${id}`,
    };
  });
}

/** Opens an in-memory store for a run without protocol rules, expanded from `queries`. */
export function createSearchStore(
  queries: Query[],
  expansionDate = '2026-10-05',
  eligibility: EligibilityRule[] = [],
) {
  const store = openStore(':memory:');
  const config = {
    catalog: { queries },
    protocol: { eligibility },
  };
  const subqueries = prepareSearchPlan(config, expansionDate);
  store.createRun({
    config,
    subqueries,
    startedAt: '2026-10-05T00:00:00.000Z',
    expansionDate,
    limits: DEFAULT_COLLECTION_LIMITS,
  });
  return { store, subqueries };
}
