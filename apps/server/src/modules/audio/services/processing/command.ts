import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export type CommandRunner = (
  file: string,
  args: string[],
  signal: AbortSignal,
  timeout: number,
) => Promise<void>;
export async function runCommand(
  file: string,
  args: string[],
  signal: AbortSignal,
  timeout: number,
  maxBuffer = 512 * 1024,
) {
  await exec(file, args, {
    signal,
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer,
  });
}
