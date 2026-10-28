import { AppError } from '../../../../core/errors/app-error';
import { speechEndpoint } from '../../speech-endpoint';
import type { WhisperAsrSettings } from '@voxel/shared';
import {
  audioFormats,
  MAX_AUDIO_BYTES,
  normalizeRecording,
} from '../processing/normalize';

function whisperPrompt(language: string, settings?: WhisperAsrSettings) {
  return (
    settings?.prompt.trim() ||
    (language === 'zh' ? '以下是简体中文的语音转写。' : '')
  );
}
export class LocalSpeech {
  private busy = false;
  constructor(
    private apiUrl = speechEndpoint(),
    private fetcher: typeof fetch = fetch,
  ) {}
  async status(_settings?: WhisperAsrSettings) {
    try {
      const base = this.apiUrl.replace(/\/v1\/?$/, '');
      const res = await this.fetcher(`${base}/health`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      if (res && (res.ok || res.status === 200)) {
        return {
          available: true,
          reason:
            '独立 Whisper 服务可连接。首次识别可能需要下载或加载模型，请稍候。',
        };
      }
      const modelsRes = await this.fetcher(
        `${this.apiUrl.replace(/\/+$/, '')}/models`,
        {
          signal: AbortSignal.timeout(3000),
        },
      ).catch(() => null);
      if (modelsRes && modelsRes.ok) {
        return {
          available: true,
          reason:
            '独立 Whisper 服务可连接。首次识别可能需要下载或加载模型，请稍候。',
        };
      }
      return {
        available: false,
        reason: '无法连接独立 Whisper 语音服务，请确认服务已启动。',
      };
    } catch {
      return {
        available: false,
        reason: '无法连接独立 Whisper 语音服务，请确认服务已启动。',
      };
    }
  }
  async normalize(audio: Buffer, contentType: string, signal: AbortSignal) {
    return normalizeRecording(audio, contentType, signal);
  }
  async transcribe(
    audio: Buffer,
    contentType: string,
    language: string,
    signal: AbortSignal,
    settings?: WhisperAsrSettings,
  ) {
    const format = audioFormats[contentType.split(';')[0].trim().toLowerCase()];
    if (!format)
      throw new AppError(
        '不支持的音频格式，请使用 WAV、WebM、MP4 或 Ogg。',
        415,
      );
    if (!audio.length || audio.length > MAX_AUDIO_BYTES)
      throw new AppError('音频不能为空且不能超过 5 MiB。', 413);
    if (!['zh', 'en'].includes(language))
      throw new AppError('只支持中文或英文识别。');
    if (this.busy)
      throw new AppError('服务器正在识别另一段录音，请稍后重试。', 429);
    this.busy = true;
    try {
      const status = await this.status(settings);
      if (!status.available) throw new AppError(status.reason, 503);
      signal.throwIfAborted();
      return await this.transcribeRemote(
        audio,
        format,
        language,
        signal,
        settings,
      );
    } catch (error) {
      if (error instanceof AppError || signal.aborted) throw error;
      throw new AppError('请求 Whisper 独立服务失败或超时。', 502);
    } finally {
      this.busy = false;
    }
  }
  private async transcribeRemote(
    audio: Buffer,
    format: string,
    language: string,
    signal: AbortSignal,
    settings?: WhisperAsrSettings,
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
        : 'Systran/faster-whisper-base',
    );
    form.append('language', language);
    const prompt = whisperPrompt(language, settings);
    if (prompt) form.append('prompt', prompt);
    if (settings?.temperature !== undefined)
      form.append('temperature', String(settings.temperature));

    const endpoint = `${this.apiUrl.replace(/\/+$/, '')}/audio/transcriptions`;
    let response = await this.fetcher(endpoint, {
      method: 'POST',
      body: form,
      signal,
    }).catch((err) => {
      if (signal.aborted) throw err;
      throw new AppError('请求 Whisper 独立服务失败或超时。', 502);
    });

    if (response.status === 404) {
      const modelId = encodeURIComponent(
        settings?.model && settings.model !== 'default'
          ? settings.model
          : 'Systran/faster-whisper-base',
      );
      const downloadEndpoint = `${this.apiUrl.replace(/\/+$/, '')}/models/${modelId}`;
      await this.fetcher(downloadEndpoint, {
        method: 'POST',
        signal,
      }).catch(() => null);

      response = await this.fetcher(endpoint, {
        method: 'POST',
        body: form,
        signal,
      }).catch((err) => {
        if (signal.aborted) throw err;
        throw new AppError('请求 Whisper 独立服务失败或超时。', 502);
      });
    }

    if (!response.ok) {
      throw new AppError(
        `Whisper 服务返回错误 (HTTP ${response.status})。`,
        502,
      );
    }
    const data = (await response.json()) as { text?: string };
    const text = (data.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || /^\[.*\]$/.test(text))
      throw new AppError('没有识别到文字，请重试。', 400, 'no-speech');
    if (text.length > 240)
      throw new AppError('识别超过 240 字，请分成更短的句子。');
    return text;
  }
}
