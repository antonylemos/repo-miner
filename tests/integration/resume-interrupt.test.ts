import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hit, humanActivityRule, page, query } from '@tests/helpers.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '@/cli/main.js';
import { DEFAULT_COLLECTION_LIMITS } from '@/modules/discovery/collection/limits.js';
import { openStore } from '@/modules/discovery/storage/store.js';
import { prepareSearchPlan } from '@/modules/discovery/study/config.js';

const evaluated = vi.hoisted(() => [] as number[]);
vi.mock('@/modules/discovery/storage/store.js', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('@/modules/discovery/storage/store.js')
    >();
  return {
    ...original,
    openStore(path: string) {
      const store = original.openStore(path);
      const save = store.saveEvaluation.bind(store);
      store.saveEvaluation = (repositoryId, ...rest) => {
        evaluated.push(repositoryId);
        save(repositoryId, ...rest);
      };
      return store;
    },
  };
});

const CANDIDATES = 4_000;
const SIGINT_AFTER_MS = 150;
const MAX_STOP_MS = 5_000;
const env = { GITHUB_TOKEN: 'fake-token' };
const directories: string[] = [];

/** A resumable round whose search is complete and whose candidates await evaluation. */
function largeRound() {
  const directory = mkdtempSync(join(tmpdir(), 'resume-interrupt-'));
  directories.push(directory);
  const config = {
    catalog: { queries: [query({ id: 'q' })] },
    protocol: { eligibility: [humanActivityRule()] },
  };
  const subqueries = prepareSearchPlan(config, '2026-10-05');
  const store = openStore(join(directory, 'discovery.sqlite'));
  store.createRun({
    config,
    subqueries,
    startedAt: '2026-10-05T00:00:00.000Z',
    expansionDate: '2026-10-05',
    limits: DEFAULT_COLLECTION_LIMITS,
  });
  for (const subquery of subqueries)
    store.savePage(
      subquery,
      1,
      page(
        subquery === subqueries[0]
          ? Array.from({ length: CANDIDATES }, (_, index) => hit(index + 1))
          : [],
      ),
      { subqueryId: subquery.id, nextPage: null, state: 'complete' },
      '2026-10-05T00:00:00.000Z',
    );
  store.close();
  return directory;
}

/** Resumes the round and sends SIGINT while it is still evaluating candidates. */
async function resumeAndInterrupt(directory: string) {
  evaluated.length = 0;
  const running = main(['discover', '--resume', directory], env);
  await new Promise((resolve) => setTimeout(resolve, SIGINT_AFTER_MS));
  const interruptedAt = performance.now();
  process.emit('SIGINT');
  const code = await running;
  return {
    code,
    stopMs: performance.now() - interruptedAt,
    evaluated: new Set(evaluated),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('should stop a resume within seconds during evaluation and continue where it left off', async () => {
  const directory = largeRound();

  const first = await resumeAndInterrupt(directory);

  expect(first.code).toBe(2);
  expect(first.stopMs).toBeLessThan(MAX_STOP_MS);
  expect(first.evaluated.size).toBeGreaterThan(0);
  expect(first.evaluated.size).toBeLessThan(CANDIDATES);
  expect(existsSync(join(directory, 'candidates.csv'))).toBe(true);

  const second = await resumeAndInterrupt(directory);

  expect(second.code).toBe(2);
  expect(second.stopMs).toBeLessThan(MAX_STOP_MS);
  expect(second.evaluated.size).toBeGreaterThan(0);
  expect([...second.evaluated].filter((id) => first.evaluated.has(id))).toEqual(
    [],
  );
}, 60_000);
