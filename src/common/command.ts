import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Runs a command and returns its stdout; rejects with the command's stderr in the message. */
export type CommandRunner = (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<string>;

export const runCommand: CommandRunner = async (file, args, options) => {
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      signal: options.signal,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    const failure = new Error(
      stderr || (error instanceof Error ? error.message : String(error)),
    );
    failure.name = (error as Error).name;
    throw failure;
  }
};
