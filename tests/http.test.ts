import { expect, it, vi } from 'vitest';
import {
  createHttpClient,
  type HttpAttemptEvent,
  type HttpRequest,
} from '../src/discovery/http.js';
import { BudgetExhaustedError } from '../src/discovery/collectors/types.js';
const token = 'secret-token';
const signal = new AbortController().signal;
const request: HttpRequest = {
  url: new URL('https://api.github.com/test'),
  lane: 'test',
  minimumIntervalMs: 0,
};
function setup(fetchFn: typeof fetch) {
  let now = 100;
  return createHttpClient({
    token,
    fetchFn,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
}
it('counts_retries_before_network', async () => {
  const order: string[] = [];
  const fetchFn = vi.fn(async () => {
    order.push('fetch');
    return new Response('ok', { status: order.length < 3 ? 500 : 200 });
  });
  await setup(fetchFn).send(
    {
      ...request,
      beforeAttempt: () => {
        order.push('reserve');
      },
    },
    signal,
  );
  expect(order).toEqual(['reserve', 'fetch', 'reserve', 'fetch']);
});
it('does_not_retry_budget_error', async () => {
  const fetchFn = vi.fn(async () => new Response('error', { status: 500 }));
  const observer = vi.fn();
  let reservations = 0;
  await expect(
    setup(fetchFn).send(
      {
        ...request,
        beforeAttempt: () => {
          if (reservations++ === 1)
            throw new BudgetExhaustedError('request_budget');
        },
        onAttemptFinished: observer,
      },
      signal,
    ),
  ).rejects.toMatchObject({ reason: 'request_budget' });
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(observer).toHaveBeenCalledTimes(1);
});
it('measures_body_and_wait', async () => {
  let calls = 0;
  const events: HttpAttemptEvent[] = [];
  const response = await setup(
    async () =>
      new Response('é', {
        status: ++calls === 1 ? 500 : 200,
        headers: { 'x-ratelimit-resource': 'core', 'x-ratelimit-used': '23' },
      }),
  ).send(
    { ...request, onAttemptFinished: (event) => events.push(event) },
    signal,
  );
  expect(await response.text()).toBe('é');
  expect(events).toEqual([
    {
      attempt: 1,
      startedAt: 100,
      finishedAt: 100,
      waitMs: 0,
      status: 500,
      responseBytes: 2,
      rateLimitResource: 'core',
      rateLimitUsed: 23,
      error: null,
    },
    {
      attempt: 2,
      startedAt: 1100,
      finishedAt: 1100,
      waitMs: 1000,
      status: 200,
      responseBytes: 2,
      rateLimitResource: 'core',
      rateLimitUsed: 23,
      error: null,
    },
  ]);
});
it('redacts_attempt_errors', async () => {
  const events: HttpAttemptEvent[] = [];
  await expect(
    setup(async () => {
      throw new Error(`failed ${token}`);
    }).send(
      { ...request, onAttemptFinished: (event) => events.push(event) },
      signal,
    ),
  ).rejects.toThrow('[REDACTED]');
  expect(events).toHaveLength(3);
  expect(
    events.every(
      (event) => event.error === 'failed [REDACTED]' && event.status === null,
    ),
  ).toBe(true);
});
it('does_not_expose_headers_or_token', async () => {
  const events: HttpAttemptEvent[] = [];
  await setup(
    async () =>
      new Response('ok', {
        headers: {
          Authorization: token,
          'x-private': token,
          'x-ratelimit-used': 'invalid',
        },
      }),
  ).send(
    { ...request, onAttemptFinished: (event) => events.push(event) },
    signal,
  );
  expect(JSON.stringify(events)).not.toContain(token);
  expect(events[0].rateLimitUsed).toBeNull();
  expect(events[0]).not.toHaveProperty('headers');
});

it('reports_received_status_when_body_read_fails', async () => {
  const observer = vi.fn();
  await expect(
    setup(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`body ${token}`));
            },
          }),
          { status: 200 },
        ),
    ).send({ ...request, onAttemptFinished: observer }, signal),
  ).rejects.toThrow('[REDACTED]');
  expect(observer).toHaveBeenCalledTimes(3);
  expect(observer.mock.calls[0][0]).toMatchObject({
    status: 200,
    responseBytes: null,
    error: 'body [REDACTED]',
  });
});
it('does_not_retry_observer_failure', async () => {
  const fetchFn = vi.fn(async () => new Response('ok'));
  await expect(
    setup(fetchFn).send(
      {
        ...request,
        onAttemptFinished: () => {
          throw new Error('persistence failed');
        },
      },
      signal,
    ),
  ).rejects.toThrow('persistence failed');
  expect(fetchFn).toHaveBeenCalledTimes(1);
});
