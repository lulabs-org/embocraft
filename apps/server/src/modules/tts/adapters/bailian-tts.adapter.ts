import type { VoiceServiceDraft } from '@voxel/shared';
import { normalizeSpeech } from '../../../core/audio/normalize';
import { AppError } from '../../../core/errors/app-error';
import type { SpeechSynthesizer } from '../services/speech-synthesizer';
import { boundedBody } from './bounded-response';

export class BailianTts implements SpeechSynthesizer {
  constructor(
    private readonly config: VoiceServiceDraft,
    private readonly request: typeof fetch = fetch,
  ) {}

  async synthesize(text: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const c = this.config;
    const audioTts = /^qwen-audio-[\d.]+-tts-/.test(c.model);
    const response = await this.request(
      `${c.baseUrl}${audioTts ? '/services/audio/tts/SpeechSynthesizer' : '/services/aigc/multimodal-generation/generation'}`,
      {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: c.model,
          input: audioTts
            ? { text, voice: c.voice, format: 'wav', sample_rate: 16000 }
            : { text, voice: c.voice, language_type: 'Auto' },
        }),
      },
    );
    const body = await boundedBody(response, 64 * 1024);
    let url: URL;
    try {
      const data = JSON.parse(body.toString('utf8'));
      url = new URL(data?.output?.audio?.url);
    } catch {
      throw new AppError(
        '百炼未返回有效的音频地址，请检查模型是否支持非流式语音合成。',
        502,
      );
    }
    // Provider output must not become an arbitrary authenticated server-side fetch.
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      !/^dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(
        url.hostname,
      )
    )
      throw new AppError('百炼返回了无法识别的音频地址。', 502);
    url.protocol = 'https:';
    const bytes = await boundedBody(
      await this.request(url, { signal, redirect: 'error' }),
      10 * 1024 * 1024,
    );
    return normalizeSpeech(bytes, signal);
  }
}
