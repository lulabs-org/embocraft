import { AppError } from '../errors/app-error';

/**
 * Parse the PCM payload of a bounded mono 16 kHz WAV and check its loudness and length.
 * The samples are returned because in-process engines decode them directly, so an
 * already correct browser recording never needs a container round-trip.
 */
export function readPcmWav(wav: Buffer, maxSeconds = 20.5) {
  if (
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new AppError('音频转换失败。');
  let pcm: Buffer | undefined,
    validFormat = false;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const id = wav.toString('ascii', offset, offset + 4),
      size = wav.readUInt32LE(offset + 4);
    if (offset + 8 + size > wav.length) throw new AppError('音频文件不完整。');
    if (id === 'fmt ' && size >= 16)
      validFormat =
        wav.readUInt16LE(offset + 8) === 1 &&
        wav.readUInt16LE(offset + 10) === 1 &&
        wav.readUInt32LE(offset + 12) === 16000 &&
        wav.readUInt16LE(offset + 22) === 16;
    if (id === 'data') pcm = wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!validFormat || !pcm || pcm.length % 2)
    throw new AppError('音频格式不正确。');
  const seconds = pcm.length / 32000;
  if (seconds < 0.25) throw new AppError('录音太短，请至少说一句话。');
  if (seconds > maxSeconds)
    throw new AppError(
      maxSeconds === 20.5
        ? '录音超过 20 秒，请分段录音。'
        : '音频过长，请分段发送。',
    );
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2)
    sum += (pcm.readInt16LE(i) / 32768) ** 2;
  if (Math.sqrt(sum / (pcm.length / 2)) < 0.003)
    throw new AppError(
      '没有检测到清晰声音，请靠近麦克风后重试。',
      400,
      'no-speech',
    );
  return { pcm, durationMs: Math.round(seconds * 1000) };
}

/** Duration-only view for callers that forward the original bytes unchanged. */
export function validatePcmWav(wav: Buffer, maxSeconds = 20.5) {
  return readPcmWav(wav, maxSeconds).durationMs;
}
