import {
  DEFAULT_SENSE_VOICE_ASR,
  type SenseVoiceAsrDraft,
} from '@voxel/shared';
import { env } from '../../../../core/config/env';
import { AppError } from '../../../../core/errors/app-error';
import {
  audioFormats,
  MAX_AUDIO_BYTES,
  normalizeRecording,
} from '../../../../core/audio/normalize';
import { readPcmWav } from '../../../../core/audio/pcm-wav';
import type {
  BatchTranscribeOptions,
  EngineStatus,
  SpeechSettings,
  SpeechTranscriberPort,
} from '../../ports';

const MAX_TEXT = 240;

/**
 * 外部 SenseVoice 服务返回的常见形态是 `{ text }`；仅接受这一种，
 * 避免把服务端错误页或调试字段误当成识别结果广播出去。
 */
function readTranscript(value: unknown): string {
  if (!value || typeof value !== 'object')
    throw new AppError('SenseVoice 返回了无效的识别结果。', 502);
  const text = (value as { text?: unknown }).text;
  if (typeof text !== 'string')
    throw new AppError('SenseVoice 返回了无效的识别结果。', 502);
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized || /^\[.*\]$/.test(normalized))
    throw new AppError('没有识别到文字，请重试。', 400, 'no-speech');
  if (normalized.length > MAX_TEXT)
    throw new AppError('识别超过 240 字，请分成更短的句子。');
  return normalized;
}

/** 外部服务按模型 ID 选择权重；`default` 映射到部署文档推荐的 SenseVoice 模型。 */
function modelName(settings?: SenseVoiceAsrDraft) {
  const model = settings?.model?.trim();
  return !model || model === 'default' ? DEFAULT_SENSE_VOICE_ASR.model : model;
}

/**
 * 外部 OpenAI 兼容的 SenseVoice 识别适配器。
 * 推理、模型下载与资源占用都在独立容器内完成，本进程只负责归一化音频、
 * 拼接请求并解析文本；地址与密钥可按服务配置覆盖，未配置时回退部署默认值。
 */
export class SenseVoiceAdapter implements SpeechTranscriberPort {
  readonly provider = 'sense-voice' as const;
  private busy = false;
  constructor(
    private apiUrl?: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  private connection(settings?: SenseVoiceAsrDraft) {
    const baseUrl = (
      settings?.baseUrl?.trim() ||
      this.apiUrl ||
      env.readSpeech().senseVoiceApiUrl
    ).replace(/\/+$/, '');
    if (!baseUrl)
      throw new AppError(
        '请配置 SenseVoice 识别服务地址（控制台 Base URL 或 SENSE_VOICE_API_URL）。',
        503,
      );
    return {
      baseUrl,
      headers: settings?.apiKey
        ? { Authorization: `Bearer ${settings.apiKey}` }
        : undefined,
    };
  }

  async status(
    settings?: SpeechSettings,
    signal?: AbortSignal,
  ): Promise<EngineStatus> {
    try {
      const connection = this.connection(settings as SenseVoiceAsrDraft);
      const base = connection.baseUrl.replace(/\/v1$/, '');
      const options = {
        headers: connection.headers,
        redirect: 'error' as const,
        signal: AbortSignal.any([
          AbortSignal.timeout(3000),
          ...(signal ? [signal] : []),
        ]),
      };
      options.signal.throwIfAborted();
      const health = await this.fetcher(`${base}/health`, options).catch(
        () => null,
      );
      if (health && health.ok)
        return {
          available: true,
          reason:
            'SenseVoice 识别服务可连接。模型在外部容器内离线运行，录音只发送到该服务。',
        };
      const models = await this.fetcher(
        `${connection.baseUrl}/models`,
        options,
      ).catch(() => null);
      if (models && models.ok)
        return {
          available: true,
          reason:
            'SenseVoice 识别服务可连接。模型在外部容器内离线运行，录音只发送到该服务。',
        };
      return {
        available: false,
        reason:
          '无法连接 SenseVoice 识别服务，请检查容器地址、模型和访问权限。',
      };
    } catch (error) {
      return {
        available: false,
        reason:
          error instanceof AppError
            ? error.message
            : '无法连接 SenseVoice 识别服务，请检查容器地址、模型和访问权限。',
      };
    }
  }

  /** 只读取远端已安装模型供控制台展示，不触发任何下载。 */
  async listModels(signal?: AbortSignal): Promise<{ name: string }[]> {
    try {
      const { baseUrl, headers } = this.connection();
      const response = await this.fetcher(`${baseUrl}/models`, {
        headers,
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(5000),
          ...(signal ? [signal] : []),
        ]),
      });
      if (!response.ok) return [];
      const value = (await response.json()) as { data?: unknown };
      if (!Array.isArray(value.data)) return [];
      const names = value.data.flatMap((item) => {
        const id = (item as { id?: unknown })?.id;
        return typeof id === 'string' && id ? [id] : [];
      });
      return [...new Set(names)].sort().map((name) => ({ name }));
    } catch {
      return [];
    }
  }

  async normalize(audio: Buffer, contentType: string, signal: AbortSignal) {
    // 浏览器快照已是 16 kHz 单声道 PCM，直接转发给外部服务，省去 FFmpeg 进程开销。
    const format = audioFormats[contentType.split(';')[0].trim().toLowerCase()];
    if (format === 'wav') {
      try {
        const { durationMs } = readPcmWav(audio);
        return { bytes: audio, durationMs };
      } catch (error) {
        if (error instanceof AppError && error.code === 'no-speech')
          throw error;
        signal.throwIfAborted();
      }
    }
    return normalizeRecording(audio, contentType, signal);
  }

  /** 同时接受选项对象和调度器使用的按位置传参形式。 */
  async transcribe(
    audio: Buffer,
    contentTypeOrOptions: string | BatchTranscribeOptions,
    language?: string,
    signal?: AbortSignal,
    settings?: SpeechSettings,
  ): Promise<string> {
    const options =
      typeof contentTypeOrOptions === 'string'
        ? {
            contentType: contentTypeOrOptions,
            language: language!,
            signal: signal!,
            settings: settings as SenseVoiceAsrDraft | undefined,
          }
        : {
            ...contentTypeOrOptions,
            settings: contentTypeOrOptions.settings as
              | SenseVoiceAsrDraft
              | undefined,
          };
    const format =
      audioFormats[options.contentType.split(';')[0].trim().toLowerCase()];
    if (!format)
      throw new AppError(
        '不支持的音频格式，请使用 WAV、WebM、MP4 或 Ogg。',
        415,
      );
    if (!audio.length || audio.length > MAX_AUDIO_BYTES)
      throw new AppError('音频不能为空且不能超过 5 MiB。', 413);
    if (!['auto', 'zh', 'en'].includes(options.language))
      throw new AppError('只支持自动、中文或英文识别。');
    if (this.busy)
      throw new AppError('服务器正在识别另一段录音，请稍后重试。', 429);

    this.busy = true;
    try {
      options.signal.throwIfAborted();
      const status = await this.status(options.settings, options.signal);
      options.signal.throwIfAborted();
      if (!status.available)
        throw new AppError(status.reason ?? 'SenseVoice 服务不可用', 503);
      const normalized = await this.normalize(
        audio,
        options.contentType,
        options.signal,
      );
      return await this.transcribeRemote(
        normalized.bytes,
        options.language,
        options.signal,
        options.settings,
      );
    } catch (error) {
      if (error instanceof AppError || options.signal.aborted) throw error;
      throw new AppError('请求 SenseVoice 识别服务失败或超时。', 502);
    } finally {
      this.busy = false;
    }
  }

  private async transcribeRemote(
    audio: Buffer,
    language: string,
    signal: AbortSignal,
    settings?: SenseVoiceAsrDraft,
  ) {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(audio)], { type: 'audio/wav' }),
      'audio.wav',
    );
    form.append('model', modelName(settings));
    // auto 交给模型自行检测；显式语言才传参，兼容不支持该字段的服务端。
    if (language !== 'auto') form.append('language', language);
    form.append('response_format', 'json');

    const connection = this.connection(settings);
    const response = await this.fetcher(
      `${connection.baseUrl}/audio/transcriptions`,
      {
        method: 'POST',
        body: form,
        signal,
        headers: connection.headers,
        redirect: 'error',
      },
    ).catch((error) => {
      if (signal.aborted) throw error;
      throw new AppError('请求 SenseVoice 识别服务失败或超时。', 502);
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        `SenseVoice 识别服务返回错误 (HTTP ${response.status})。`,
        502,
      );
    }
    return readTranscript(await response.json());
  }
}
