import type { HttpClientOptions } from '@/modules/discovery/http/client.js';
import type { Progress } from './progress.js';

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function clientOptions(
  token: string,
  progress: Progress,
): HttpClientOptions {
  return {
    token,
    fetchFn: globalThis.fetch,
    now: Date.now,
    sleep: async (ms, signal) => {
      progress.wait(ms);
      try {
        await sleepAbortably(ms, signal);
      } finally {
        progress.wait(0);
      }
    },
  };
}

/** Runs work with a SIGINT-aware signal and redacts the token from any error. */
export async function withInterrupt<T>(
  token: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortOnSigint = () =>
    controller.abort(new Error('Interrupted by SIGINT'));
  process.once('SIGINT', abortOnSigint);
  try {
    return await work(controller.signal);
  } catch (error) {
    throw new Error(redactMessage(error, token));
  } finally {
    process.removeListener('SIGINT', abortOnSigint);
  }
}

function sleepAbortably(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal.aborted) {
      rejectSleep(signal.reason ?? new Error('Request aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolveSleep();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      rejectSleep(signal.reason ?? new Error('Request aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function redactMessage(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return token.length > 0 ? message.split(token).join('[REDACTED]') : message;
}
