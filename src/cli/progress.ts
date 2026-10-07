import type { ProtocolProgressEvent } from '../discovery/protocol-runner.js';

const BAR_WIDTH = 24;
/** Estimates from the first few seconds of a phase are mostly noise. */
const ETA_AFTER_MS = 5_000;

export type ProgressStream = Pick<NodeJS.WriteStream, 'write'> & {
  isTTY?: boolean;
  columns?: number;
};

export type Progress = {
  /** Starts a phase with its own total, resetting the counter. */
  start(title: string, total: number): void;
  /** Sets how many units are done; `label` describes what was just finished. */
  update(done: number, label?: string): void;
  /** Shows a countdown while the HTTP client waits before the next request. */
  wait(ms: number): void;
  /** Clears the line so later output starts on a clean terminal row. */
  done(): void;
};

const silent: Progress = {
  start() {},
  update() {},
  wait() {},
  done() {},
};

/** Draws a single-line progress bar on a TTY stream; does nothing otherwise. */
export function createProgress(
  stream: ProgressStream = process.stderr,
  now: () => number = Date.now,
): Progress {
  if (!stream.isTTY) return silent;

  let title = '';
  let total = 0;
  let current = 0;
  let label = '';
  let waitUntil = 0;
  let startedAt = 0;
  let timer: NodeJS.Timeout | undefined;

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const render = () => {
    const ratio = total > 0 ? Math.min(1, current / total) : 0;
    const filled = Math.round(ratio * BAR_WIDTH);
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    const percent = `${Math.floor(ratio * 100)}%`.padStart(4);
    const remaining = Math.ceil((waitUntil - now()) / 1_000);
    const status = remaining > 0 ? `aguardando ${remaining}s` : label;
    const elapsed = now() - startedAt;
    const eta =
      current > 0 && current < total && elapsed >= ETA_AFTER_MS
        ? ` · ~${formatDuration((elapsed / current) * (total - current))}`
        : '';
    const line = `${title} ${bar} ${current}/${total} ${percent}${eta}${status ? ` · ${status}` : ''}`;
    const width = stream.columns ?? 80;
    stream.write(
      `\r\x1b[2K${line.length >= width ? `${line.slice(0, width - 2)}…` : line}`,
    );
  };

  return {
    start(nextTitle, nextTotal) {
      title = nextTitle;
      total = nextTotal;
      current = 0;
      label = '';
      startedAt = now();
      render();
    },
    update(done, nextLabel) {
      current = done;
      label = nextLabel ?? '';
      render();
    },
    wait(ms) {
      waitUntil = now() + ms;
      stopTimer();
      render();
      if (ms <= 0) return;
      timer = setInterval(() => {
        if (now() >= waitUntil) stopTimer();
        render();
      }, 1_000);
      timer.unref();
    },
    done() {
      stopTimer();
      stream.write('\r\x1b[2K');
    },
  };
}

function formatDuration(ms: number): string {
  const seconds = Math.ceil(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** Maps discovery phase events to the terminal presentation. */
export function createDiscoveryProgress(
  progress: Progress,
): (
  event:
    | ProtocolProgressEvent
    | { phase: 'enrichment'; done: number; total: number; label: string },
) => void {
  let phase = '';
  let total = -1;
  return (event) => {
    if (phase !== event.phase || total !== event.total) {
      phase = event.phase;
      total = event.total;
      progress.start(
        event.phase === 'search'
          ? 'Buscando'
          : event.phase === 'activity'
            ? 'Coletando atividade'
            : 'Enriquecendo',
        event.total,
      );
    }
    progress.update(event.done, event.label);
  };
}
