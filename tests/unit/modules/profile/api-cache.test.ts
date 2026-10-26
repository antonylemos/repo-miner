import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiCache } from '@/modules/profile/api-cache.js';

afterEach(removeTemporaryDirectories);

const FIRST = 'https://api.github.com/repos/o/r/stargazers?per_page=100';
const SECOND = `${FIRST}&page=2`;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), init);
}

function pagesOf(...responses: Array<Response | Error>) {
  const queue = [...responses];
  return vi.fn<typeof fetch>(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
}

function cacheOf(
  directory: string,
  fetchFn: typeof fetch,
  token: string | null = 'token',
) {
  return createApiCache({
    directory,
    token: token ?? undefined,
    http: { fetchFn, now: () => NOW, sleep: async () => {} },
  });
}

const request = { repository: 'o__r', endpoint: 'stargazers', url: FIRST };

describe('createApiCache', () => {
  it('should follow the next link and keep every page with its address and instant', async () => {
    const directory = temporaryDirectory();
    const fetchFn = pagesOf(
      json([{ n: 1 }], { headers: { link: `<${SECOND}>; rel="next"` } }),
      json([{ n: 2 }]),
    );
    const cache = cacheOf(directory, fetchFn);
    const result = await cache.collect({
      ...request,
      accept: 'application/vnd.github.star+json',
    });
    expect(result.status).toBe(200);
    expect(result.pages.map((page) => page.body)).toEqual([
      [{ n: 1 }],
      [{ n: 2 }],
    ]);
    expect(cache.fetchedPages()).toBe(2);
    expect(readdirSync(join(directory, 'o__r')).sort()).toEqual([
      'stargazers-1.json',
      'stargazers-2.json',
    ]);
    const saved = JSON.parse(
      readFileSync(join(directory, 'o__r', 'stargazers-1.json'), 'utf8'),
    );
    expect(saved).toMatchObject({
      url: FIRST,
      fetchedAt: '2026-10-24T12:00:00.000Z',
      status: 200,
      body: [{ n: 1 }],
    });
    const headers = fetchFn.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Accept).toBe('application/vnd.github.star+json');
  });

  it('should read a complete cache again without a token or the network', async () => {
    const directory = temporaryDirectory();
    const first = cacheOf(
      directory,
      pagesOf(
        json([1], { headers: { link: `<${SECOND}>; rel="next"` } }),
        json([2]),
      ),
    );
    const before = await first.collect(request);
    const fetchFn = pagesOf();
    const second = cacheOf(directory, fetchFn, null);
    const after = await second.collect(request);
    expect(after).toEqual(before);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(second.fetchedPages()).toBe(0);
  });

  it('should ask for the token only when a page is missing', async () => {
    const directory = temporaryDirectory();
    const cache = cacheOf(directory, pagesOf(), null);
    await expect(cache.collect(request)).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('should keep the earlier pages when a later one fails and continue from there', async () => {
    const directory = temporaryDirectory();
    const failing = cacheOf(
      directory,
      pagesOf(
        json([1], { headers: { link: `<${SECOND}>; rel="next"` } }),
        json({ message: 'boom' }, { status: 422 }),
      ),
    );
    await expect(failing.collect(request)).rejects.toThrow(/422/);
    expect(existsSync(join(directory, 'o__r', 'stargazers-1.json'))).toBe(true);
    expect(existsSync(join(directory, 'o__r', 'stargazers-2.json'))).toBe(
      false,
    );

    const fetchFn = pagesOf(json([2]));
    const resumed = cacheOf(directory, fetchFn);
    const result = await resumed.collect(request);
    expect(result.pages.map((page) => page.body)).toEqual([[1], [2]]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(SECOND);
  });

  it.each([404, 451])('should keep a %i answer and stop', async (status) => {
    const directory = temporaryDirectory();
    const cache = cacheOf(
      directory,
      pagesOf(json({ message: 'gone' }, { status })),
    );
    const result = await cache.collect(request);
    expect(result.status).toBe(status);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.body).toBeNull();

    const again = await cacheOf(directory, pagesOf(), null).collect(request);
    expect(again.status).toBe(status);
  });

  it('should fetch again a page that was kept for another address', async () => {
    const directory = temporaryDirectory();
    await cacheOf(directory, pagesOf(json([1]))).collect(request);
    const fetchFn = pagesOf(json([9]));
    const result = await cacheOf(directory, fetchFn).collect({
      ...request,
      url: `${FIRST}&other=1`,
    });
    expect(result.pages[0]?.body).toEqual([9]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('should fetch again a damaged page', async () => {
    const directory = temporaryDirectory();
    await cacheOf(directory, pagesOf(json([1]))).collect(request);
    writeFileSync(join(directory, 'o__r', 'stargazers-1.json'), '{');
    const result = await cacheOf(directory, pagesOf(json([2]))).collect(
      request,
    );
    expect(result.pages[0]?.body).toEqual([2]);
  });
});
