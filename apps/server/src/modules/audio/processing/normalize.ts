import { env } from '../../../core/config/env';
import { AppError } from '../../../core/errors/app-error';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePcmWav } from './pcm-wav';
import { runCommand, type CommandRunner } from './command';

export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export const audioFormats: Record<string, string> = {
  'audio/webm': 'matroska',
  'audio/mp4': 'mov',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

export async function normalizeRecording(
  audio: Buffer,
  contentType: string,
  signal: AbortSignal,
  ffmpeg = env.readSpeech().ffmpegBin,
  runner: CommandRunner = runCommand,
) {
  const format = audioFormats[contentType.split(';')[0].trim().toLowerCase()];
  if (!format || !audio.length || audio.length > MAX_AUDIO_BYTES)
    throw new AppError('音频格式或大小无效。');
  const dir = await mkdtemp(join(tmpdir(), 'voxel-clip-'));
  try {
    const input = join(dir, 'input'),
      output = join(dir, 'audio.wav');
    await writeFile(input, audio, { mode: 0o600 });
    await convertToPcmWav(input, output, signal, {
      ffmpeg,
      runner,
      format,
      maxSeconds: 21,
      timeoutMs: 15000,
    });
    const bytes = await readFile(output);
    const durationMs = validatePcmWav(bytes);
    return { bytes, durationMs };
  } catch (error) {
    if (error instanceof AppError || signal.aborted) throw error;
    throw new AppError('无法处理录音，请检查服务器上的 FFmpeg 或重试。', 502);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Normalize provider WAV output to the same bounded PCM format used by world audio. */
export async function normalizeSpeech(
  bytes: Buffer,
  signal: AbortSignal,
  runner: CommandRunner = (file, args, signal, timeout) =>
    runCommand(file, args, signal, timeout, 256 * 1024),
) {
  signal.throwIfAborted();
  try {
    return { bytes, durationMs: validatePcmWav(bytes, 90.5) };
  } catch {
    // Providers may return other WAV sample rates; convert those below.
  }
  if (
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new AppError('语音服务未返回 WAV 音频。', 502);
  const dir = await mkdtemp(join(tmpdir(), 'voxel-cloud-tts-'));
  try {
    const input = join(dir, 'input.wav'),
      output = join(dir, 'output.wav');
    await writeFile(input, bytes, { mode: 0o600 });
    await convertToPcmWav(input, output, signal, {
      ffmpeg: env.readSpeech().ffmpegBin,
      runner,
      maxSeconds: 91,
      timeoutMs: 30000,
    });
    signal.throwIfAborted();
    const wav = await readFile(output);
    return { bytes: wav, durationMs: validatePcmWav(wav, 90.5) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Fixed PCM output; each caller retains its input format, time and process limits. */
export function convertToPcmWav(
  input: string,
  output: string,
  signal: AbortSignal,
  options: {
    ffmpeg: string;
    runner: CommandRunner;
    format?: string;
    maxSeconds: number;
    timeoutMs: number;
  },
) {
  return options.runner(
    options.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      ...(options.format ? ['-f', options.format] : []),
      '-i',
      input,
      '-t',
      String(options.maxSeconds),
      '-vn',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      output,
    ],
    signal,
    options.timeoutMs,
  );
}
