import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogHash } from '../src/discovery/catalog.js';
import { exportRun } from '../src/discovery/report.js';
import { openStore } from '../src/discovery/storage.js';
import type {
  Catalog,
  Query,
  SearchHit,
  SearchPage,
} from '../src/discovery/types.js';

const dirs: string[] = [];
const queryA: Query = {
  id: 'query-a',
  strategy: 'terminology',
  endpoint: 'repositories',
  q: 'microfrontend',
};
const queryB: Query = {
  id: 'query-b',
  strategy: 'technology',
  endpoint: 'code',
  q: 'single-spa',
};
const queryC: Query = {
  id: 'query-c',
  strategy: 'broader',
  endpoint: 'repositories',
  q: 'frontend composition',
};
const catalog: Catalog = { version: 1, queries: [queryA, queryB, queryC] };
const stores: ReturnType<typeof openStore>[] = [];

function createStore(runCatalog: Catalog = catalog) {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-report-'));
  dirs.push(dir);
  const store = openStore(join(dir, 'discovery.sqlite'));
  stores.push(store);
  store.createRun(runCatalog, catalogHash(runCatalog), 'started');
  return { dir, store };
}

function hit(id: number, path: string | null = null): SearchHit {
  return {
    candidate: {
      id,
      fullName: `org/repo-${id}`,
      url: `https://github.com/org/repo-${id}`,
      metadata: { stars: 10 },
    },
    path,
    url: path
      ? `https://github.com/org/repo-${id}/blob/main/${path}`
      : `https://github.com/org/repo-${id}`,
  };
}

function savePage(
  store: ReturnType<typeof openStore>,
  query: Query,
  hits: SearchHit[],
  state: 'complete' | 'partial' | 'failed' | 'pending' = 'complete',
  reason?: string,
) {
  const page: SearchPage = {
    totalCount: hits.length,
    incomplete: state === 'partial',
    hits,
    hasNext: false,
  };
  const checkpoint = {
    queryId: query.id,
    nextPage: state === 'complete' || state === 'partial' ? null : 1,
    state,
  } as const;
  store.savePage(query, 1, page, checkpoint, 'fetched');
  if (reason) store.markQuery(checkpoint, reason);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('exportRun', () => {
  it('should export each candidate once', async () => {
    const { dir, store } = createStore();
    savePage(store, queryA, [hit(1), hit(2)]);
    savePage(store, queryB, [hit(1)]);

    await exportRun(store, dir);

    const rows = readFileSync(join(dir, 'candidates.csv'), 'utf8')
      .trim()
      .split('\n');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('1,org/repo-1');
    expect(rows[2]).toContain('2,org/repo-2');
  });

  it('should retain every query and code path in the hit export', async () => {
    const { dir, store } = createStore();
    savePage(store, queryA, [hit(1)]);
    savePage(store, queryB, [hit(1, 'src/one.ts'), hit(1, 'src/two.ts')]);

    await exportRun(store, dir);

    const csv = readFileSync(join(dir, 'discovery-hits.csv'), 'utf8');
    const rows = csv.trim().split('\n');
    expect(rows).toHaveLength(4);
    expect(csv).toContain('query-a,terminology,1');
    expect(csv).toContain('query-b,technology,1');
    expect(csv).toContain('src/one.ts');
    expect(csv).toContain('src/two.ts');
  });

  it('should escape commas quotes Unicode and line breaks in CSV fields', async () => {
    const { dir, store } = createStore();
    const ordinaryHit = hit(3, 'src/ação,"component"\nnext.ts');
    const specialHit: SearchHit = {
      ...ordinaryHit,
      candidate: {
        ...ordinaryHit.candidate,
        fullName: 'org/ação,"repo"\nnext-line',
      },
    };
    savePage(store, queryB, [specialHit]);

    await exportRun(store, dir);

    const candidatesCsv = readFileSync(join(dir, 'candidates.csv'), 'utf8');
    const hitsCsv = readFileSync(join(dir, 'discovery-hits.csv'), 'utf8');
    expect(candidatesCsv).toContain('"org/ação,""repo""\nnext-line"');
    expect(hitsCsv).toContain('"src/ação,""component""\nnext.ts"');
  });

  it('should order candidates queries and paths deterministically', async () => {
    const uppercaseQuery: Query = { ...queryA, id: 'B' };
    const lowercaseQuery: Query = { ...queryB, id: 'a' };
    const orderedCatalog: Catalog = {
      version: 1,
      queries: [lowercaseQuery, uppercaseQuery],
    };
    const { dir, store } = createStore(orderedCatalog);
    savePage(store, lowercaseQuery, [hit(1, 'z.ts'), hit(2, 'z.ts')]);
    savePage(store, uppercaseQuery, [
      hit(1, 'z.ts'),
      hit(1, 'a.ts'),
      hit(2, 'a.ts'),
    ]);

    await exportRun(store, dir);

    const rows = readFileSync(join(dir, 'discovery-hits.csv'), 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((row) => {
        const fields = row.split(',');
        return `${fields[2]}:${fields[0]}:${fields[5]}`;
      });
    expect(rows).toEqual([
      '1:B:a.ts',
      '1:B:z.ts',
      '1:a:z.ts',
      '2:B:a.ts',
      '2:a:z.ts',
    ]);
  });

  it('should report hit and candidate counts with partial failed and pending queries', async () => {
    const { dir, store } = createStore();
    savePage(store, queryA, [hit(1)], 'partial', 'result cap reached');
    savePage(store, queryB, [hit(1, 'src/app.ts')], 'pending');
    store.markQuery(
      { queryId: queryC.id, nextPage: 1, state: 'failed' },
      'temporary error',
    );

    await exportRun(store, dir);

    const report = readFileSync(join(dir, 'report.md'), 'utf8');
    const coverage = JSON.parse(
      readFileSync(join(dir, 'coverage.json'), 'utf8'),
    ) as {
      coverage: Array<{
        queryId: string;
        fetchedHits: number;
        uniqueCandidates: number;
        state: string;
      }>;
    };
    expect(coverage.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ queryId: 'query-a', state: 'partial' }),
        expect.objectContaining({ queryId: 'query-b', state: 'pending' }),
        expect.objectContaining({ queryId: 'query-c', state: 'failed' }),
      ]),
    );
    expect(coverage.coverage[0]).toMatchObject({
      fetchedHits: 1,
      uniqueCandidates: 1,
    });
    expect(report).toContain('query-a');
    expect(report).toContain('query-b');
    expect(report).toContain('query-c');
    expect(report).toContain('result cap reached');
    expect(report).toContain('terminology ∩ technology: 1 repositórios');
    expect(report).toContain('query-a: revisar ou reformular a consulta.');
  });

  it('should state that confirmed approach counts are unavailable', async () => {
    const { dir, store } = createStore();

    await exportRun(store, dir);

    const report = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(report).toContain(
      'Contagens de implementações confirmadas não estão disponíveis',
    );
  });

  it('should record run versions and hashes of every exported data file', async () => {
    const { dir, store } = createStore();

    const result = await exportRun(store, dir);

    const manifest = JSON.parse(
      readFileSync(join(dir, 'manifest.json'), 'utf8'),
    ) as {
      schemaVersion: number;
      run: { id: string; catalogHash: string; startedAt: string };
      versions: {
        node: string;
        code: string | null;
        lockfileVersion: string | null;
        lockfileSha256: string | null;
      };
      git: { available: boolean; revision: string | null; reason?: string };
      sha256: Record<string, string>;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.run).toMatchObject({
      id: store.getRun().id,
      catalogHash: store.getRun().catalogHash,
      startedAt: 'started',
    });
    expect(manifest.versions.node).toBe(process.version);
    expect(manifest.versions.code).toBeTruthy();
    expect(manifest.versions.lockfileVersion).toBe('9.0');
    expect(typeof manifest.git.available).toBe('boolean');
    if (!manifest.git.available) expect(manifest.git.reason).toBeTruthy();
    for (const file of result.files) {
      if (file.endsWith('manifest.json')) continue;
      const name = file.split('/').at(-1) as string;
      const expectedHash = createHash('sha256')
        .update(readFileSync(file))
        .digest('hex');
      expect(manifest.sha256[name]).toBe(expectedHash);
    }
  });
});
