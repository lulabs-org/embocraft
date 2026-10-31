import { normalizeSpeech } from '../../../core/audio/normalize';
import type { VoiceServiceDraft } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import type { SpeechSynthesizer } from './speech-synthesizer';

async function boundedBody(response: Response, limit: number) {
  if (!response.ok) {
    let detail = '';
    try {
      const data = JSON.parse(
        (await readBody(response, 64 * 1024)).toString('utf8'),
      );
      // Use provider text only for classification: it may echo credentials or input.
      detail = [data.code, data.message, data.error?.code, data.error?.message]
        .filter((v) => typeof v === 'string')
        .join(' ')
        .toLowerCase();
    } catch {
      // HTML, malformed and oversized error bodies still receive a useful fallback.
    }
    const hint =
      response.status === 401 || /invalidapikey|invalid_api_key/.test(detail)
        ? 'API Key 无效或已过期，请检查密钥与接口地域。'
        : response.status === 403
          ? '无权调用此服务，请检查模型权限与密钥地域。'
          : response.status === 429
            ? '调用额度或频率受限，请检查配额后稍后重试。'
            : /voice|speaker|音色/.test(detail)
              ? '音色不可用，请检查音色 ID 是否属于当前模型。'
              : /model|模型/.test(detail)
                ? '模型不可用或与接口不匹配，请检查模型 ID、地域和调用权限。'
                : response.status === 400
                  ? '请求参数不被接受，请检查模型、音色与接口是否匹配。'
                  : '服务暂不可用，请检查接口地址或稍后重试。';
    throw new AppError(`语音服务返回 HTTP ${response.status}：${hint}`, 502);
  }
  return readBody(response, limit);
}

async function readBody(response: Response, limit: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) throw new AppError('语音服务返回空响应。', 502);
  const reader = response.body.getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) throw new AppError('语音服务响应过大。', 502);
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export class RemoteTts implements SpeechSynthesizer {
  constructor(
    private config: VoiceServiceDraft,
    private request = fetch,
  ) {}
  async synthesize(text: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const c = this.config;
    const bailian = c.type === 'bailian';
    const audioTts = bailian && /^qwen-audio-[\d.]+-tts-/.test(c.model);
    const response = await this.request(
      `${c.baseUrl}${
        bailian
          ? audioTts
            ? '/services/audio/tts/SpeechSynthesizer'
            : '/services/aigc/multimodal-generation/generation'
          : '/audio/speech'
      }`,
      {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
        },
        body: JSON.stringify(
          bailian
            ? {
                model: c.model,
                input: audioTts
                  ? { text, voice: c.voice, format: 'wav', sample_rate: 16000 }
                  : { text, voice: c.voice, language_type: 'Auto' },
              }
            : {
                model: c.model,
                input: text,
                voice: c.voice,
                speed: c.speed,
                response_format: 'wav',
              },
        ),
      },
    );
    let bytes = await boundedBody(
      response,
      bailian ? 64 * 1024 : 10 * 1024 * 1024,
    );
    if (bailian) {
      let url: URL;
      try {
        const data = JSON.parse(bytes.toString('utf8'));
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
      bytes = await boundedBody(
        await this.request(url, { signal, redirect: 'error' }),
        10 * 1024 * 1024,
      );
    }
    return normalizeSpeech(bytes, signal);
  }
}
