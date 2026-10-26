import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { page } from '@tests/profile-helpers.js';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { writeCsv } from '@/common/csv.js';
import {
  compareWithDiscovery,
  readDiscoveryObservations,
} from '@/modules/profile/validation.js';

afterEach(removeTemporaryDirectories);

const OBSERVED = '2026-10-08T15:44:41.978Z';

function observation(
  data: Record<string, unknown>,
  options: { status?: string; observedAt?: string } = {},
) {
  return {
    observedAt: options.observedAt ?? OBSERVED,
    status: options.status ?? 'ok',
    data,
  };
}

async function discovery(
  rows: Array<{ id: string; observations: unknown[] }>,
): Promise<string> {
  const directory = temporaryDirectory();
  mkdirSync(directory, { recursive: true });
  await writeCsv(
    join(directory, 'candidates.csv'),
    ['id', 'full_name', 'evidence_json'],
    rows.map((row) => [
      row.id,
      `org/r${row.id}`,
      JSON.stringify({ observations: row.observations }),
    ]),
  );
  return directory;
}

describe('readDiscoveryObservations', () => {
  it('should read the stars and forks with their instants for the asked ids', async () => {
    const directory = await discovery([
      {
        id: '1',
        observations: [
          observation(
            { forks_count: 2 },
            { observedAt: '2026-10-08T15:42:00Z' },
          ),
          observation({ stargazerCount: 5 }),
          observation(
            { forks_count: 2 },
            { observedAt: '2026-10-08T15:42:00Z' },
          ),
        ],
      },
      { id: '2', observations: [observation({ stargazerCount: 9 })] },
    ]);
    const found = await readDiscoveryObservations(directory, new Set(['1']));
    expect([...found.keys()]).toEqual(['1']);
    expect(found.get('1')).toEqual([
      { measure: 'forks', at: '2026-10-08T15:42:00Z', value: 2 },
      { measure: 'stars', at: OBSERVED, value: 5 },
    ]);
  });

  it('should ignore failed observations and missing values', async () => {
    const directory = await discovery([
      {
        id: '1',
        observations: [
          observation({ stargazerCount: 5 }, { status: 'failed' }),
          observation({}),
        ],
      },
    ]);
    const found = await readDiscoveryObservations(directory, new Set(['1']));
    expect(found.get('1')).toEqual([]);
  });

  it('should reject a missing file', async () => {
    await expect(
      readDiscoveryObservations(temporaryDirectory(), new Set()),
    ).rejects.toThrow(/does not exist/);
  });
});

const base = {
  id: '1',
  fullName: 'org/a',
  observations: [],
  starCount: null,
  forks: null,
  apiCommits: null,
  cloneCommits: 10,
  referenceAt: '2026-10-12T00:00:00.000Z',
};

describe('compareWithDiscovery', () => {
  it('should compare the star count with each observation of the discovery', () => {
    const rows = compareWithDiscovery({
      ...base,
      observations: [{ measure: 'stars', at: OBSERVED, value: 3 }],
      starCount: 5,
    });
    expect(rows).toEqual([
      {
        id: '1',
        fullName: 'org/a',
        measure: 'stars',
        at: OBSERVED,
        reconstructed: 5,
        recorded: 3,
        difference: 2,
      },
    ]);
  });

  it('should rebuild the forks at the instant of the observation', () => {
    const forks = page([
      { created_at: '2026-10-01T00:00:00Z' },
      { created_at: '2026-10-09T00:00:00Z' },
    ]);
    const rows = compareWithDiscovery({
      ...base,
      observations: [{ measure: 'forks', at: OBSERVED, value: 2 }],
      forks: [forks],
    });
    expect(rows).toEqual([
      {
        id: '1',
        fullName: 'org/a',
        measure: 'forks',
        at: OBSERVED,
        reconstructed: 1,
        recorded: 2,
        difference: -1,
      },
    ]);
  });

  it('should give no row for a measure the discovery did not record', () => {
    const rows = compareWithDiscovery({
      ...base,
      observations: [{ measure: 'stars', at: OBSERVED, value: 0 }],
      starCount: 1,
      forks: [page([])],
    });
    expect(rows.map((row) => row.measure)).toEqual(['stars']);
  });

  it('should compare the commits of the API with those of the clone', () => {
    const rows = compareWithDiscovery({ ...base, apiCommits: 12 });
    expect(rows).toEqual([
      {
        id: '1',
        fullName: 'org/a',
        measure: 'commits',
        at: '2026-10-12T00:00:00.000Z',
        reconstructed: 12,
        recorded: 10,
        difference: 2,
      },
    ]);
  });

  it('should give no row when the API had no answer', () => {
    const rows = compareWithDiscovery({
      ...base,
      observations: [{ measure: 'forks', at: OBSERVED, value: 1 }],
    });
    expect(rows).toEqual([]);
  });

  it('should order the observations of a measure by instant', () => {
    const rows = compareWithDiscovery({
      ...base,
      observations: [
        { measure: 'forks', at: '2026-10-08T16:00:00Z', value: 1 },
        { measure: 'forks', at: '2026-10-08T15:00:00Z', value: 1 },
      ],
      forks: [page([])],
    });
    expect(rows.map((row) => row.at)).toEqual([
      '2026-10-08T15:00:00Z',
      '2026-10-08T16:00:00Z',
    ]);
  });
});
