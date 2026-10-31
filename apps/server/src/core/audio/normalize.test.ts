import { expect, it, vi } from 'vitest';
import { access, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeRecording, normalizeSpeech } from './normalize';
import type { CommandRunner } from './command';

function wav(seconds = 1, sampleRate = 16000) {
  const data = Buffer.alloc(44 + seconds * 32000);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(data.length - 44, 40);
  for (let i = 44; i < data.length; i += 2) data.writeInt16LE(1000, i);
  return data;
}

it('keeps recording and synthesized audio duration and conversion policies separate', async () => {
  const signal = new AbortController().signal;
  const runner = vi.fn<CommandRunner>(async (_file, args) => {
    await writeFile(args.at(-1)!, wav(30));
  });
  await expect(
    normalizeRecording(
      Buffer.from('recording'),
      'audio/webm;codecs=opus',
      signal,
      'fixture-ffmpeg',
      runner,
    ),
  ).rejects.toMatchObject({
    status: 400,
    message: '录音超过 20 秒，请分段录音。',
  });
  const recording = runner.mock.calls[0];
  expect(recording[1]).toEqual(
    expect.arrayContaining(['-f', 'matroska', '-t', '21', 'file,pipe']),
  );
  expect(recording[2]).toBe(signal);
  expect(recording[3]).toBe(15000);
  await expect(access(dirname(recording[1].at(-1)!))).rejects.toThrow();

  const converted = await normalizeSpeech(wav(30, 24000), signal, runner);
  expect(converted.durationMs).toBe(30000);
  const synthesized = runner.mock.calls[1];
  expect(synthesized[1]).toContain('91');
  expect(synthesized[1]).not.toContain('-f');
  expect(synthesized[2]).toBe(signal);
  expect(synthesized[3]).toBe(30000);
  await expect(access(dirname(synthesized[1].at(-1)!))).rejects.toThrow();
  // Valid provider PCM needs no subprocess, including speech longer than a recording.
  await expect(normalizeSpeech(wav(30), signal, runner)).resolves.toMatchObject(
    { durationMs: 30000 },
  );
  expect(runner).toHaveBeenCalledTimes(2);
});

it('cleans temporary recording and synthesized files after cancellation', async () => {
  for (const recording of [true, false]) {
    const controller = new AbortController();
    const reason = Error('fixture cancellation');
    const runner = vi.fn<CommandRunner>(async () => {
      controller.abort(reason);
      throw reason;
    });
    const pending = recording
      ? normalizeRecording(
          Buffer.from('recording'),
          'audio/wav',
          controller.signal,
          'fixture-ffmpeg',
          runner,
        )
      : normalizeSpeech(wav(1, 24000), controller.signal, runner);
    await expect(pending).rejects.toBe(reason);
    await expect(
      access(dirname(runner.mock.calls[0][1].at(-1)!)),
    ).rejects.toThrow();
  }
});

it('preserves recording conversion errors and removes temporary files after success', async () => {
  const runner = vi
    .fn<CommandRunner>()
    .mockRejectedValueOnce(Error('process failed'));
  const signal = new AbortController().signal;
  await expect(
    normalizeRecording(
      Buffer.from('recording'),
      'audio/wav',
      signal,
      'fixture-ffmpeg',
      runner,
    ),
  ).rejects.toMatchObject({
    status: 502,
    message: '无法处理录音，请检查服务器上的 FFmpeg 或重试。',
  });
  await expect(
    access(dirname(runner.mock.calls[0][1].at(-1)!)),
  ).rejects.toThrow();
  runner.mockImplementation(async (_file, args) => {
    await writeFile(args.at(-1)!, wav());
  });
  await expect(
    normalizeRecording(
      Buffer.from('recording'),
      'audio/wav',
      signal,
      'fixture-ffmpeg',
      runner,
    ),
  ).resolves.toMatchObject({ durationMs: 1000 });
  await expect(
    access(dirname(runner.mock.calls[1][1].at(-1)!)),
  ).rejects.toThrow();
});
