import { AppError } from '../../../core/errors/app-error';

type Segment = {
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
};

const invalidResponse = () =>
  new AppError('Whisper 返回了无效的识别结果。', 502);

/** Use segment evidence when available; never fall back to rejected aggregate text. */
export function readWhisperTranscript(value: unknown): string {
  if (!value || typeof value !== 'object') throw invalidResponse();
  const data = value as { text?: unknown; segments?: unknown };
  if (typeof data.text !== 'string') throw invalidResponse();
  let text = data.text;
  if (data.segments !== undefined) {
    if (!Array.isArray(data.segments)) throw invalidResponse();
    const segments: Segment[] = data.segments.map((item: unknown) => {
      if (!item || typeof item !== 'object') throw invalidResponse();
      const segment = item as Segment;
      if (typeof segment.text !== 'string') throw invalidResponse();
      for (const key of [
        'avg_logprob',
        'no_speech_prob',
        'compression_ratio',
      ] as const) {
        if (
          segment[key] !== undefined &&
          (typeof segment[key] !== 'number' || !Number.isFinite(segment[key]))
        )
          throw invalidResponse();
      }
      return segment;
    });
    text = segments
      .filter((segment) => {
        // Match Whisper's silence thresholds, and require weak decoding evidence
        // before suppressing repetition so real repeated words remain valid.
        const uncertain =
          segment.avg_logprob !== undefined && segment.avg_logprob < -1;
        const silent =
          segment.no_speech_prob !== undefined && segment.no_speech_prob > 0.6;
        const repetitive =
          segment.compression_ratio !== undefined &&
          segment.compression_ratio > 2.4;
        return !(uncertain && (silent || repetitive));
      })
      .map((segment) => segment.text)
      .join('');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || /^\[.*\]$/.test(text))
    throw new AppError('没有识别到文字，请重试。', 400, 'no-speech');
  if (text.length > 240)
    throw new AppError('识别超过 240 字，请分成更短的句子。');
  return text;
}
