import { describe, expect, it, vi } from 'vitest';
import { createDiscoveryProgress, createProgress } from '@/cli/progress.js';

function fakeStream(isTTY: boolean, columns = 120) {
  const writes: string[] = [];
  return {
    writes,
    stream: {
      isTTY,
      columns,
      write: (chunk: string) => writes.push(chunk) > 0,
    },
  };
}

describe('createProgress', () => {
  it('should write nothing when the stream is not a TTY', () => {
    const { writes, stream } = fakeStream(false);
    const progress = createProgress(stream);

    progress.start('Contando', 4);
    progress.update(1, 'q1');
    progress.done();

    expect(writes).toEqual([]);
  });

  it('should redraw one line with count, percent and label', () => {
    const { writes, stream } = fakeStream(true);
    let now = 0;
    const progress = createProgress(stream, () => now);

    progress.start('Contando', 4);
    now = 2_000;
    progress.update(1, 'q1');

    expect(writes.at(-1)).toBe(
      `\r\x1b[2KContando ${'█'.repeat(6)}${'░'.repeat(18)} 1/4  25% · q1`,
    );
  });

  it('should estimate the remaining time from the average pace', () => {
    const { writes, stream } = fakeStream(true);
    let now = 0;
    const progress = createProgress(stream, () => now);

    progress.start('Contando', 100);
    now = 30_000;
    progress.update(10, 'q10');

    expect(writes.at(-1)).toContain('10/100  10% · ~4m30s · q10');
  });

  it('should show the remaining wait instead of the label', () => {
    const { writes, stream } = fakeStream(true);
    let now = 0;
    const progress = createProgress(stream, () => now);

    progress.start('Contando', 2);
    progress.update(1, 'q1');
    progress.wait(6_000);
    expect(writes.at(-1)).toContain('aguardando 6s');

    now = 6_000;
    progress.wait(0);
    expect(writes.at(-1)).toContain('· q1');
    progress.done();
  });

  it('should truncate lines wider than the terminal', () => {
    const { writes, stream } = fakeStream(true, 20);
    const progress = createProgress(stream);

    progress.start('Contando', 10);

    expect(writes.at(-1)?.replace('\r\x1b[2K', '')).toHaveLength(19);
  });
});

it('should map search, metadata and activity progress phases', () => {
  const progress = {
    start: vi.fn(),
    update: vi.fn(),
    wait: vi.fn(),
    done: vi.fn(),
  };
  const report = createDiscoveryProgress(progress);
  for (const phase of ['search', 'refresh', 'metadata', 'activity'] as const)
    report({ phase, done: 1, total: 2, label: 'repo' });
  expect(progress.start.mock.calls).toEqual([
    ['Buscando', 2],
    ['Avaliando', 2],
    ['Enriquecendo', 2],
    ['Coletando atividade', 2],
  ]);
  expect(progress.update).toHaveBeenCalledTimes(4);
});
