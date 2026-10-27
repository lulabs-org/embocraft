import { env } from '../../../core/config/env';
import { AppError } from '../../../core/errors/app-error';
import { speechEndpoint } from '../speech-endpoint';
import type { WhisperAsrSettings } from '@voxel/shared';
import { whisperModelPath } from './whisper-settings';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executable,
  runCommand,
  type CommandRunner,
} from '../services/processing/command';
import { validatePcmWav } from '../domain/pcm-wav';
import {
  audioFormats,
  MAX_AUDIO_BYTES,
  normalizeRecording,
  convertToPcmWav,
} from '../services/processing/normalize';

function whisperPrompt(language: string, settings?: WhisperAsrSettings) {
  return (
    settings?.prompt.trim() ||
    (language === 'zh' ? '以下是简体中文的语音转写。' : '')
  );
}
export class LocalSpeech {
  private busy = false;
  constructor(
    private model = env.readSpeech().whisperModel ??
      env.dataPath('voice/ggml-base.bin'),
    private whisper = env.readSpeech().whisperBin ?? 'whisper-cli',
    private ffmpeg = env.readSpeech().ffmpegBin,
    private runner: CommandRunner = runCommand,
    private apiUrl = !env.readSpeech().whisperApiUrl?.trim() &&
    !env.readSpeech().speechApiUrl?.trim() &&
    (env.readSpeech().whisperBin?.trim() ||
      env.readSpeech().whisperModel?.trim())
      ? ''
      : speechEndpoint('whisper'),
    private fetcher: typeof fetch = fetch,
  ) {}
  async status(settings?: WhisperAsrSettings) {
    if (this.apiUrl) {
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
    try {
      const [model, whisper, ffmpeg] = await Promise.all([
        stat(
          settings ? whisperModelPath(settings.model, this.model) : this.model,
        ),
        executable(this.whisper),
        executable(this.ffmpeg),
      ]);
      if (model.size < 1024 * 1024 || !model.isFile()) throw Error('model');
      if (!whisper || !ffmpeg)
        return {
          available: false,
          reason: '缺少 whisper-cli 或 ffmpeg，请按语音配置文档安装。',
        };
      return {
        available: true,
        reason:
          '自托管 Whisper 已就绪。音频上传至项目服务器，由服务器完成识别。',
      };
    } catch {
      return {
        available: false,
        reason: settings
          ? '所选 Whisper 模型不可用，请确认模型已安装在服务器。'
          : '缺少本地语音模型，请运行 pnpm voice:setup 后重试。',
      };
    }
  }
  async normalize(audio: Buffer, contentType: string, signal: AbortSignal) {
    return normalizeRecording(
      audio,
      contentType,
      signal,
      this.ffmpeg,
      this.runner,
    );
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
    let dir: string | undefined;
    try {
      const status = await this.status(settings);
      if (!status.available) throw new AppError(status.reason, 503);
      signal.throwIfAborted();
      if (this.apiUrl) {
        return await this.transcribeRemote(
          audio,
          format,
          language,
          signal,
          settings,
        );
      }
      dir = await mkdtemp(join(tmpdir(), 'voxel-speech-'));
      const input = join(dir, 'input'),
        wav = join(dir, 'audio.wav'),
        output = join(dir, 'transcript');
      await writeFile(input, audio, { mode: 0o600 });
      await convertToPcmWav(input, wav, signal, {
        ffmpeg: this.ffmpeg,
        runner: this.runner,
        format,
        maxSeconds: 21,
        timeoutMs: 15000,
      });
      validatePcmWav(await readFile(wav));
      const prompt = whisperPrompt(language, settings);
      await this.runner(
        this.whisper,
        [
          '-m',
          settings ? whisperModelPath(settings.model, this.model) : this.model,
          '-f',
          wav,
          '-l',
          language,
          '-otxt',
          '-of',
          output,
          '-nt',
          '-np',
          '-sns',
          '-ng',
          '-t',
          String(settings?.threads ?? 4),
          ...(settings
            ? [
                '-bs',
                String(settings.beamSize),
                '-tp',
                String(settings.temperature),
              ]
            : []),
          ...(prompt ? ['--prompt', prompt] : []),
        ],
        signal,
        90000,
      );
      signal.throwIfAborted();
      const text = (await readFile(`${output}.txt`, 'utf8'))
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || /^\[.*\]$/.test(text))
        throw new AppError('没有识别到文字，请重试。', 400, 'no-speech');
      if (text.length > 240)
        throw new AppError('识别超过 240 字，请分成更短的句子。');
      return text;
    } catch (error) {
      if (error instanceof AppError || signal.aborted) throw error;
      throw new AppError(
        '服务器识别失败或超时，请使用有效短录音，并检查 Whisper 模型与工具。',
        502,
      );
    } finally {
      try {
        if (dir) await rm(dir, { recursive: true, force: true });
      } finally {
        this.busy = false;
      }
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

    const endpoint = `${this.apiUrl!.replace(/\/+$/, '')}/audio/transcriptions`;
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
      const downloadEndpoint = `${this.apiUrl!.replace(/\/+$/, '')}/models/${modelId}`;
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
