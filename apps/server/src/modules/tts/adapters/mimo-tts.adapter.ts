import type { VoiceServiceDraft } from '@voxel/shared';
import { normalizeSpeech } from '../../../core/audio/normalize';
import { AppError } from '../../../core/errors/app-error';
import type { SpeechSynthesizer } from '../services/speech-synthesizer';
import { boundedBody } from './bounded-response';

/**
 * Xiaomi MiMo synthesizes through the chat-completions contract: the spoken
 * text travels in an assistant message, delivery hints in a user message, and
 * the audio returns inline as base64 rather than through /audio/speech.
 */
export class MimoTts implements SpeechSynthesizer {
  constructor(
    private readonly config: VoiceServiceDraft,
    private readonly request: typeof fetch = fetch,
  ) {}

  async synthesize(text: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const c = this.config;
    // MiMo has no numeric speed parameter: a non-default speed travels as a
    // natural-language hint in the leading user message.
    const response = await this.request(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        // MiMo documents `api-key`; OpenAI-compatible clients send the bearer.
        ...(c.apiKey
          ? {
              'api-key': c.apiKey,
              Authorization: `Bearer ${c.apiKey}`,
            }
          : {}),
      },
      body: JSON.stringify({
        model: c.model,
        messages: [
          ...(c.speed !== 1
            ? [
                {
                  role: 'user',
                  content:
                    c.speed < 1
                      ? `请用约 ${c.speed} 倍的慢速朗读。`
                      : `请用约 ${c.speed} 倍的快速朗读。`,
                },
              ]
            : []),
          { role: 'assistant', content: text },
        ],
        audio: { format: 'wav', voice: c.voice },
        stream: false,
      }),
    });
    // The envelope carries base64 audio, so cap the JSON before decoding it.
    const body = await boundedBody(response, 10 * 1024 * 1024);
    let data: unknown;
    try {
      // Only a chat completion that actually spoke exposes inline audio here.
      data = JSON.parse(body.toString('utf8'))?.choices?.[0]?.message?.audio
        ?.data;
    } catch {
      throw new AppError(
        '小米 MiMo 未返回有效的音频数据，请检查模型与音色配置。',
        502,
      );
    }
    if (typeof data !== 'string' || !data)
      throw new AppError(
        '小米 MiMo 未返回音频，请检查模型是否支持语音合成。',
        502,
      );
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length)
      throw new AppError('小米 MiMo 返回了空的音频数据。', 502);
    // MiMo may emit other sample rates; normalize to the 16 kHz mono PCM WAV
    // that world audio playback and storage expect.
    return normalizeSpeech(bytes, signal);
  }
}
