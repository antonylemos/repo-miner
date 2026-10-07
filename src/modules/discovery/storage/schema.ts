const RUNS = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    catalog_hash TEXT NOT NULL,
    protocol_hash TEXT NOT NULL,
    versions_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    expansion_date TEXT NOT NULL,
    ended_at TEXT,
    state TEXT NOT NULL
  );
`;

const QUERIES = `
  CREATE TABLE IF NOT EXISTS queries (
    query_id TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL UNIQUE,
    strategy TEXT NOT NULL,
    endpoint TEXT NOT NULL CHECK (endpoint IN ('repositories', 'code')),
    q TEXT NOT NULL,
    rationale TEXT NOT NULL,
    partition_json TEXT
  );
`;

const SUBQUERIES = `
  CREATE TABLE IF NOT EXISTS subqueries (
    subquery_id TEXT PRIMARY KEY,
    query_id TEXT NOT NULL REFERENCES queries(query_id),
    ordinal INTEGER NOT NULL UNIQUE,
    q_effective TEXT NOT NULL,
    partition_label TEXT NOT NULL
  );
`;

const PAGES = `
  CREATE TABLE IF NOT EXISTS pages (
    subquery_id TEXT NOT NULL REFERENCES subqueries(subquery_id),
    page INTEGER NOT NULL CHECK (page >= 1),
    total_count INTEGER NOT NULL CHECK (total_count >= 0),
    incomplete INTEGER NOT NULL CHECK (incomplete IN (0, 1)),
    fetched_at TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY (subquery_id, page)
  );
`;

const CANDIDATES = `
  CREATE TABLE IF NOT EXISTS candidates (
    repository_id INTEGER PRIMARY KEY,
    node_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    url TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    facts_revision INTEGER NOT NULL DEFAULT 0
  );
`;

const HITS = `
  CREATE TABLE IF NOT EXISTS hits (
    subquery_id TEXT NOT NULL REFERENCES subqueries(subquery_id),
    query_id TEXT NOT NULL REFERENCES queries(query_id),
    repository_id INTEGER NOT NULL REFERENCES candidates(repository_id),
    path TEXT NOT NULL,
    url TEXT NOT NULL,
    full_name TEXT NOT NULL,
    repository_url TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (subquery_id, repository_id, path)
  );
`;

const CHECKPOINTS = `
  CREATE TABLE IF NOT EXISTS checkpoints (
    subquery_id TEXT PRIMARY KEY REFERENCES subqueries(subquery_id),
    next_page INTEGER CHECK (next_page IS NULL OR next_page >= 1),
    state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'partial', 'failed')),
    reason TEXT
  );
`;

const HITS_OBSERVATION_INDEX = `
  CREATE INDEX IF NOT EXISTS hits_repository_observation
    ON hits (repository_id, fetched_at, subquery_id, path);
`;

const REPOSITORY_OBSERVATIONS = `
  CREATE TABLE IF NOT EXISTS repository_observations (
    id TEXT PRIMARY KEY,
    repository_id INTEGER NOT NULL REFERENCES candidates(repository_id),
    data_json TEXT NOT NULL
  );
`;

const INSPECTIONS = `
  CREATE TABLE IF NOT EXISTS inspections (
    repository_id INTEGER PRIMARY KEY REFERENCES candidates(repository_id),
    until TEXT NOT NULL
  );
`;

const ACTIVITY_REFS = `
  CREATE TABLE IF NOT EXISTS activity_refs (
    repository_id INTEGER NOT NULL REFERENCES candidates(repository_id),
    id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (repository_id, id)
  );
`;

const ACTIVITY_COMMITS = `
  CREATE TABLE IF NOT EXISTS activity_commits (
    repository_id INTEGER NOT NULL REFERENCES candidates(repository_id),
    sha TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (repository_id, sha)
  );
`;

const COLLECTION_TASKS = `
  CREATE TABLE IF NOT EXISTS collection_tasks (
    id TEXT PRIMARY KEY,
    repository_id INTEGER NOT NULL REFERENCES candidates(repository_id),
    request_json TEXT NOT NULL,
    state TEXT NOT NULL,
    checkpoint_json TEXT,
    reason TEXT
  );
`;

const ACTIVITY_COMMIT_REFS = `
  CREATE TABLE IF NOT EXISTS activity_commit_refs (
    repository_id INTEGER NOT NULL,
    ref_id TEXT NOT NULL,
    sha TEXT NOT NULL,
    PRIMARY KEY (repository_id, ref_id, sha),
    FOREIGN KEY (repository_id, ref_id) REFERENCES activity_refs(repository_id, id),
    FOREIGN KEY (repository_id, sha) REFERENCES activity_commits(repository_id, sha)
  );
`;

const COLLECTION_PAGES = `
  CREATE TABLE IF NOT EXISTS collection_pages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES collection_tasks(id),
    data_json TEXT NOT NULL
  );
`;

const INVOCATIONS = `
  CREATE TABLE IF NOT EXISTS invocations (
    id TEXT PRIMARY KEY,
    limits_json TEXT NOT NULL,
    started_at TEXT NOT NULL
  );
`;

const COLLECTION_ATTEMPTS = `
  CREATE TABLE IF NOT EXISTS collection_attempts (
    id INTEGER PRIMARY KEY,
    task_id TEXT REFERENCES collection_tasks(id),
    repository_id INTEGER REFERENCES candidates(repository_id),
    invocation_id TEXT NOT NULL REFERENCES invocations(id),
    kind TEXT NOT NULL,
    targets_json TEXT,
    event_json TEXT
  );
`;

const COLLECTION_DURATIONS = `
  CREATE TABLE IF NOT EXISTS collection_durations (
    task_id TEXT NOT NULL REFERENCES collection_tasks(id),
    invocation_id TEXT NOT NULL REFERENCES invocations(id),
    duration_ms REAL NOT NULL
  );
`;

const EVALUATIONS = `
  CREATE TABLE IF NOT EXISTS evaluations (
    repository_id INTEGER PRIMARY KEY REFERENCES candidates(repository_id),
    facts_revision INTEGER NOT NULL,
    data_json TEXT NOT NULL
  );
`;

const COLLECTION_FACT_INVOCATIONS = `
  CREATE TABLE IF NOT EXISTS collection_fact_invocations (
    repository_id INTEGER NOT NULL REFERENCES candidates(repository_id),
    invocation_id TEXT NOT NULL REFERENCES invocations(id),
    kind TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    PRIMARY KEY (repository_id, invocation_id, kind, fact_id)
  );
`;

const TASK_REFS = `
  CREATE TABLE IF NOT EXISTS task_refs (
    task_id TEXT NOT NULL REFERENCES collection_tasks(id),
    repository_id INTEGER NOT NULL,
    ref_id TEXT NOT NULL,
    PRIMARY KEY (task_id, repository_id, ref_id),
    FOREIGN KEY (repository_id, ref_id) REFERENCES activity_refs(repository_id, id)
  );
`;

/** Tables are listed in dependency order so every REFERENCES target exists first. */
export const SCHEMA = [
  RUNS,
  QUERIES,
  SUBQUERIES,
  PAGES,
  CANDIDATES,
  HITS,
  CHECKPOINTS,
  HITS_OBSERVATION_INDEX,
  REPOSITORY_OBSERVATIONS,
  INSPECTIONS,
  ACTIVITY_REFS,
  ACTIVITY_COMMITS,
  COLLECTION_TASKS,
  ACTIVITY_COMMIT_REFS,
  COLLECTION_PAGES,
  INVOCATIONS,
  COLLECTION_ATTEMPTS,
  COLLECTION_DURATIONS,
  EVALUATIONS,
  COLLECTION_FACT_INVOCATIONS,
  TASK_REFS,
].join('');
