import { AppError } from '../../../common/errors';
import {
  audioFormats,
  MAX_AUDIO_BYTES,
  normalizeRecording,
} from '../processing/normalize';
import type {
  SpeechSettings,
  SpeechStatus,
  SpeechTranscriber,
} from './speech-transcriber';

/** Map the accepted upload formats onto the multipart filename OpenAI expects. */
const uploads: Record<string, { extension: string; mime: string }> = {
  wav: { extension: 'wav', mime: 'audio/wav' },
  matroska: { extension: 'webm', mime: 'audio/webm' },
  mov: { extension: 'm4a', mime: 'audio/mp4' },
  ogg: { extension: 'ogg', mime: 'audio/ogg' },
};

/**
 * Forwards 16 kHz snapshots to any endpoint implementing the OpenAI
 * `/audio/transcriptions` contract (OpenAI, Groq, self-hosted gateways).
 * The project server keeps the key; browsers never see it.
 */
export class OpenAiSpeech implements SpeechTranscriber {
  constructor(private fetcher: typeof fetch = fetch) {}
  async status(settings?: SpeechSettings): Promise<SpeechStatus> {
    if (!settings || settings.provider !== 'openai')
      return {
        available: false,
        reason: '请选择已保存的 OpenAI 兼容识别服务。',
      };
    return {
      available: true,
      reason:
        '音频由项目服务器转发到远程 OpenAI 兼容接口识别；请确保服务器可访问该地址且密钥有效。',
    };
  }
  async normalize(audio: Buffer, contentType: string, signal: AbortSignal) {
    return normalizeRecording(audio, contentType, signal);
  }
  async transcribe(
    audio: Buffer,
    contentType: string,
    language: string,
    signal: AbortSignal,
    settings?: SpeechSettings,
  ) {
    if (!settings || settings.provider !== 'openai')
      throw new AppError('请选择已保存的 OpenAI 兼容识别服务。');
    const format = audioFormats[contentType.split(';')[0].trim().toLowerCase()];
    const upload = format ? uploads[format] : undefined;
    if (!upload)
      throw new AppError(
        '不支持的音频格式，请使用 WAV、WebM、MP4 或 Ogg。',
        415,
      );
    if (!audio.length || audio.length > MAX_AUDIO_BYTES)
      throw new AppError('音频不能为空且不能超过 5 MiB。', 413);
    if (!['zh', 'en'].includes(language))
      throw new AppError('只支持中文或英文识别。');
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(audio)], { type: upload.mime }),
      `audio.${upload.extension}`,
    );
    form.append('model', settings.model);
    form.append('language', language);
    const response = await this.fetcher(
      `${settings.baseUrl}/audio/transcriptions`,
      {
        method: 'POST',
        headers: settings.apiKey
          ? { Authorization: `Bearer ${settings.apiKey}` }
          : {},
        body: form,
        signal,
      },
    ).catch((error: unknown) => {
      if (signal.aborted) throw error;
      throw new AppError('请求 OpenAI 兼容识别接口失败或超时。', 502);
    });
    if (response.status === 401 || response.status === 403)
      throw new AppError(
        `OpenAI 兼容接口拒绝访问 (HTTP ${response.status})，请检查 API Key。`,
        502,
      );
    if (!response.ok)
      throw new AppError(
        `OpenAI 兼容接口返回错误 (HTTP ${response.status})。`,
        502,
      );
    const data = (await response.json().catch(() => null)) as {
      text?: unknown;
    } | null;
    const text =
      typeof data?.text === 'string'
        ? data.text.replace(/\s+/g, ' ').trim()
        : '';
    if (!text || /^\[.*\]$/.test(text))
      throw new AppError('没有识别到文字，请重试。', 400, 'no-speech');
    if (text.length > 240)
      throw new AppError('识别超过 240 字，请分成更短的句子。');
    return text;
  }
}
