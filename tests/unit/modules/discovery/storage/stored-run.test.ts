import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { humanActivityRule, query } from '@tests/helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_COLLECTION_LIMITS } from '@/modules/discovery/collection/limits.js';
import { openStore } from '@/modules/discovery/storage/store.js';
import {
  readOriginalPageSizes,
  readStoredStudyConfig,
} from '@/modules/discovery/storage/stored-run.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function database(withRun: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'stored-run-'));
  directories.push(directory);
  const path = join(directory, 'discovery.sqlite');
  const store = openStore(path);
  const config = {
    catalog: { queries: [query({ id: 'q' })] },
    protocol: { eligibility: [humanActivityRule()] },
  };
  if (withRun)
    store.createRun({
      config,
      subqueries: [],
      startedAt: '2026-10-06T00:00:00Z',
      expansionDate: '2026-10-06',
      limits: { ...DEFAULT_COLLECTION_LIMITS, commitsPerPage: 50 },
    });
  store.close();
  return { path, config };
}

function update(path: string, sql: string, ...values: string[]) {
  const db = new DatabaseSync(path);
  db.prepare(sql).run(...values);
  db.close();
}

describe('readStoredStudyConfig', () => {
  it('should return the stored catalog and protocol', () => {
    const { path, config } = database(true);
    expect(readStoredStudyConfig(path)).toEqual(config);
  });
  it('should reject a database without a run', () => {
    const { path } = database(false);
    expect(() => readStoredStudyConfig(path)).toThrow(
      'No discovery run has been created',
    );
  });
  it('should reject a stored configuration without a protocol', () => {
    const { path } = database(true);
    update(
      path,
      'UPDATE runs SET config_json = ?',
      JSON.stringify({ catalog: { queries: [] } }),
    );
    expect(() => readStoredStudyConfig(path)).toThrow(
      'Invalid stored protocol configuration',
    );
  });
  it('should not modify the database', () => {
    const { path } = database(true);
    const before = readFileSync(path);
    readStoredStudyConfig(path);
    expect(readFileSync(path)).toEqual(before);
  });
});

describe('readOriginalPageSizes', () => {
  it('should return the page sizes of the first invocation', () => {
    const { path } = database(true);
    expect(readOriginalPageSizes(path)).toEqual({
      commitsPerPage: 50,
      branchesPerPage: DEFAULT_COLLECTION_LIMITS.branchesPerPage,
    });
  });
  it('should reject a database without an invocation', () => {
    const { path } = database(false);
    expect(() => readOriginalPageSizes(path)).toThrow(
      'Missing original collection limits.',
    );
  });
  it.each([101, 0, 1.5])('should reject a stored page size of %s', (size) => {
    const { path } = database(true);
    update(
      path,
      'UPDATE invocations SET limits_json = ?',
      JSON.stringify({ commitsPerPage: size, branchesPerPage: 100 }),
    );
    expect(() => readOriginalPageSizes(path)).toThrow(
      'Invalid stored pagination size.',
    );
  });
});
