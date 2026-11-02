import { AppError } from '../../../../core/errors/app-error';
import { speechEndpoint } from '../../../../core/audio/speech-endpoint';
import { DEFAULT_WHISPER_ASR, type WhisperAsrDraft } from '@voxel/shared';
import { readWhisperTranscript } from '../../services/transcript';
import {
  audioFormats,
  MAX_AUDIO_BYTES,
  normalizeRecording,
} from '../../../../core/audio/normalize';
import type {
  BatchTranscribeOptions,
  BatchTranscriberPort,
  EngineStatus,
} from '../../ports';

/**
 * Whisper / Speaches 批处理音频识别适配器，实现 BatchTranscriberPort
 */
export class WhisperAdapter implements BatchTranscriberPort {
  readonly provider = 'whisper' as const;
  private busy = false;

  constructor(
    private apiUrl = speechEndpoint(),
    private fetcher: typeof fetch = fetch,
  ) {}

  private connection(settings?: WhisperAsrDraft) {
    return {
      baseUrl: (settings?.baseUrl?.trim() || this.apiUrl).replace(/\/+$/, ''),
      headers: settings?.apiKey
        ? { Authorization: `Bearer ${settings.apiKey}` }
        : undefined,
    };
  }

  async status(
    settings?: WhisperAsrDraft,
    signal?: AbortSignal,
  ): Promise<EngineStatus> {
    try {
      const connection = this.connection(settings);
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
      const res = await this.fetcher(`${base}/health`, options).catch(
        () => null,
      );
      if (res && (res.ok || res.status === 200)) {
        return {
          available: true,
          reason:
            'Speaches 识别服务可连接。首次识别可能需要下载或加载模型，请稍候。',
        };
      }
      const modelsRes = await this.fetcher(
        `${connection.baseUrl}/models`,
        options,
      ).catch(() => null);
      if (modelsRes && modelsRes.ok) {
        return {
          available: true,
          reason:
            'Speaches 识别服务可连接。首次识别可能需要下载或加载模型，请稍候。',
        };
      }
      return {
        available: false,
        reason: '无法连接 Speaches 识别服务，请检查服务地址和 API Key。',
      };
    } catch {
      return {
        available: false,
        reason: '无法连接 Speaches 识别服务，请检查服务地址和 API Key。',
      };
    }
  }

  async normalize(audio: Buffer, contentType: string, signal: AbortSignal) {
    return normalizeRecording(audio, contentType, signal);
  }

  /**
   * 批处理转录音频（支持 BatchTranscribeOptions 参数对象或分立参数）
   */
  async transcribe(
    audio: Buffer,
    contentTypeOrOptions: string | BatchTranscribeOptions,
    language?: string,
    signal?: AbortSignal,
    settings?: WhisperAsrDraft,
  ): Promise<string> {
    let contentType: string;
    let actualLanguage: string;
    let actualSignal: AbortSignal;
    let actualSettings: WhisperAsrDraft | undefined;

    if (typeof contentTypeOrOptions === 'string') {
      contentType = contentTypeOrOptions;
      actualLanguage = language!;
      actualSignal = signal!;
      actualSettings = settings;
    } else {
      contentType = contentTypeOrOptions.contentType;
      actualLanguage = contentTypeOrOptions.language;
      actualSignal = contentTypeOrOptions.signal;
      actualSettings = contentTypeOrOptions.settings;
    }

    const format = audioFormats[contentType.split(';')[0].trim().toLowerCase()];
    if (!format)
      throw new AppError(
        '不支持的音频格式，请使用 WAV、WebM、MP4 或 Ogg。',
        415,
      );
    if (!audio.length || audio.length > MAX_AUDIO_BYTES)
      throw new AppError('音频不能为空且不能超过 5 MiB。', 413);
    if (!['auto', 'zh', 'en'].includes(actualLanguage))
      throw new AppError('只支持自动检测、中文或英文识别。');
    if (this.busy)
      throw new AppError('服务器正在识别另一段录音，请稍后重试。', 429);

    this.busy = true;
    try {
      actualSignal.throwIfAborted();
      const status = await this.status(actualSettings, actualSignal);
      actualSignal.throwIfAborted();
      if (!status.available) throw new AppError(status.reason ?? '服务不可用', 503);
      return await this.transcribeRemote(
        audio,
        format,
        actualLanguage,
        actualSignal,
        actualSettings,
      );
    } catch (error) {
      if (error instanceof AppError || actualSignal.aborted) throw error;
      throw new AppError('请求 Speaches 识别服务失败或超时。', 502);
    } finally {
      this.busy = false;
    }
  }

  private async transcribeRemote(
    audio: Buffer,
    format: string,
    language: string,
    signal: AbortSignal,
    settings?: WhisperAsrDraft,
  ) {
    const ext =
      format === 'wav'
        ? 'wav'
        : format === 'matroska'
          ? 'webm'
          : format === 'mov'
            ? 'm4a'
            : 'ogg';
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(audio)], {
        type:
          format === 'matroska'
            ? 'audio/webm'
            : format === 'mov'
              ? 'audio/mp4'
              : `audio/${format}`,
      }),
      `audio.${ext}`,
    );
    form.append(
      'model',
      settings?.model && settings.model !== 'default'
        ? settings.model
        : DEFAULT_WHISPER_ASR.model,
    );
    if (language !== 'auto') form.append('language', language);
    form.append('vad_filter', 'true');
    form.append('response_format', 'verbose_json');

    const prompt = settings?.prompt.trim();
    if (prompt) form.append('prompt', prompt);
    if (settings?.temperature !== undefined)
      form.append('temperature', String(settings.temperature));

    const connection = this.connection(settings);
    const endpoint = `${connection.baseUrl}/audio/transcriptions`;
    const options = {
      signal,
      headers: connection.headers,
      redirect: 'error' as const,
    };
    let response = await this.fetcher(endpoint, {
      method: 'POST',
      body: form,
      ...options,
    }).catch((err) => {
      if (signal.aborted) throw err;
      throw new AppError('请求 Speaches 识别服务失败或超时。', 502);
    });

    if (response.status === 404) {
      const modelId = encodeURIComponent(
        settings?.model && settings.model !== 'default'
          ? settings.model
          : DEFAULT_WHISPER_ASR.model,
      );
      const downloadEndpoint = `${connection.baseUrl}/models/${modelId}`;
      await this.fetcher(downloadEndpoint, {
        method: 'POST',
        ...options,
      }).catch(() => null);

      response = await this.fetcher(endpoint, {
        method: 'POST',
        body: form,
        ...options,
      }).catch((err) => {
        if (signal.aborted) throw err;
        throw new AppError('请求 Speaches 识别服务失败或超时。', 502);
      });
    }

    if (!response.ok) {
      throw new AppError(
        `Speaches 识别服务返回错误 (HTTP ${response.status})。`,
        502,
      );
    }
    return readWhisperTranscript(await response.json());
  }
}
