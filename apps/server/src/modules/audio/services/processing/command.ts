import { env } from '../../../../core/config/env';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
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
export async function executable(name: string) {
  const candidates = name.includes('/')
    ? [name]
    : env
        .readSpeech()
        .path.split(delimiter)
        .map((dir) => join(dir, name));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* Try next PATH entry. */
    }
  }
  return undefined;
}
