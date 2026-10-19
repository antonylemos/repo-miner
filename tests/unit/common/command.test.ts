import { describe, expect, it } from 'vitest';
import { runCommand } from '@/common/command.js';

describe('runCommand', () => {
  it('should return the stdout of the command', async () => {
    expect(
      await runCommand('node', ['-e', 'process.stdout.write("ok")'], {}),
    ).toBe('ok');
  });

  it('should pass the extra environment to the command', async () => {
    const out = await runCommand(
      'node',
      ['-e', 'process.stdout.write(process.env.GIT_NO_LAZY_FETCH ?? "")'],
      { env: { GIT_NO_LAZY_FETCH: '1' } },
    );
    expect(out).toBe('1');
  });

  it('should reject with the stderr of a failing command', async () => {
    await expect(
      runCommand('node', ['-e', 'console.error("boom"); process.exit(3)'], {}),
    ).rejects.toThrow('boom');
  });
});
