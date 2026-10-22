import { env } from '../../../config/env';
import { AppError } from '../../../common/errors';
import type {
  OfflineRecognizerConfig,
  OfflineRecognizerResult,
  Waveform,
} from 'sherpa-onnx-node';
import type { SenseVoiceAsrSettings } from '@voxel/shared';
import {
  listSenseVoiceModels,
  resolveSenseVoiceModel,
  senseVoiceRoot,
  type SenseVoiceModel,
} from './sense-voice-models';
import {
  audioFormats,
  MAX_AUDIO_BYTES,
  normalizeRecording,
} from '../processing/normalize';
import { readPcmWav } from '../processing/pcm-wav';
import { runCommand, type CommandRunner } from '../processing/command';
import type { SpeechStatus } from './speech-transcriber';

const SAMPLE_RATE = 16000;
const MAX_TEXT = 240;

/** Narrow view of the sherpa-onnx offline recognizer, so tests can inject a double. */
export type SenseVoiceStream = { acceptWaveform(waveform: Waveform): void };
export type SenseVoiceDecoder = {
  setConfig(config: OfflineRecognizerConfig): void;
  createStream(hotwords?: string): SenseVoiceStream;
  decodeAsync(stream: SenseVoiceStream): Promise<OfflineRecognizerResult>;
};
export type SherpaOfflineModule = {
  OfflineRecognizer: {
    createAsync(config: OfflineRecognizerConfig): Promise<SenseVoiceDecoder>;
  };
};

async function loadSherpaModule() {
  const namespace = (await import(
    'sherpa-onnx-node'
  )) as unknown as SherpaOfflineModule & { default?: SherpaOfflineModule };
  // CommonJS interop exposes the exports object either directly or under `default`.
  return namespace.OfflineRecognizer ? namespace : namespace.default!;
}

/** A saved profile wins; requests without one fall back to the game's zh/en choice. */
function languageCode(
  language: string,
  settings?: Partial<SenseVoiceAsrSettings>,
) {
  if (settings?.language) return settings.language;
  return language === 'en' ? 'en' : 'zh';
}

function toFloat32Pcm(pcm: Buffer) {
  const samples = new Float32Array(pcm.length / 2);
  for (let i = 0; i < samples.length; i++)
    samples[i] = pcm.readInt16LE(i * 2) / 32768;
  return samples;
}

/**
 * Local, offline speech-to-text with SenseVoice through sherpa-onnx.
 * One ONNX session is shared by every request: loading the int8 graph costs
 * several hundred MB, so the language switch is applied to the live session
 * instead of creating another recognizer.
 */
export class SenseVoiceSpeech {
  readonly provider = 'sense-voice' as const;
  private recognizer?: SenseVoiceDecoder;
  private loading?: Promise<SenseVoiceDecoder>;
  private loadedModel?: string;
  private config?: OfflineRecognizerConfig;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private modelRoot = senseVoiceRoot(),
    private threads = env.readSpeech().asrThreads,
    private ffmpeg = env.readSpeech().ffmpegBin,
    private runner: CommandRunner = runCommand,
    private loadSherpa: () => Promise<SherpaOfflineModule> = loadSherpaModule,
  ) {}

  /** The model directory decides the session; per-service settings do not. */
  private async model(settings?: Partial<SenseVoiceAsrSettings>) {
    return resolveSenseVoiceModel(settings?.model ?? 'default', this.modelRoot);
  }

  /** Readiness only checks the model files; the graph is loaded on first use. */
  status: (settings?: Partial<SenseVoiceAsrSettings>) => Promise<SpeechStatus> =
    async (settings) => {
      try {
        const model = await this.model(settings);
        return {
          available: true,
          reason: `本地 SenseVoice（${model.name}）已就绪，录音只在项目服务器内识别，不上传到任何第三方。首次识别会加载模型，可能需要几秒。`,
        };
      } catch (error) {
        if (error instanceof AppError)
          return { available: false, reason: error.message };
        return {
          available: false,
          reason:
            '本地 SenseVoice 推理组件不可用，请确认服务器已安装 sherpa-onnx-node。',
        };
      }
    };

  async listModels() {
    return listSenseVoiceModels(this.modelRoot);
  }

  private async ensure(model: SenseVoiceModel, language: string) {
    if (this.recognizer && this.loadedModel === model.model) {
      this.applyLanguage(language);
      return this.recognizer;
    }
    this.loading ??= (async () => {
      const sherpa = await this.loadSherpa();
      const config: OfflineRecognizerConfig = {
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          senseVoice: {
            model: model.model,
            language,
            useInverseTextNormalization: 1,
          },
          tokens: model.tokens,
          numThreads: this.threads,
          provider: 'cpu',
          debug: 0,
        },
      };
      const recognizer = await sherpa.OfflineRecognizer.createAsync(config);
      this.recognizer = recognizer;
      this.config = config;
      this.loadedModel = model.model;
      this.loading = undefined;
      return recognizer;
    })();
    try {
      return await this.loading;
    } catch (error) {
      this.loading = undefined;
      throw error;
    }
  }

  /** Free to call: it only rewrites the language condition token inside the loaded graph. */
  private applyLanguage(language: string) {
    if (!this.recognizer || !this.config?.modelConfig?.senseVoice) return;
    if (this.config.modelConfig.senseVoice.language === language) return;
    this.config.modelConfig.senseVoice.language = language;
    this.recognizer.setConfig(this.config);
  }

  async normalize(audio: Buffer, contentType: string, signal: AbortSignal) {
    const format = audioFormats[contentType.split(';')[0].trim().toLowerCase()];
    if (!format || !audio.length || audio.length > MAX_AUDIO_BYTES)
      throw new AppError('音频格式或大小无效。');
    // Browser snapshots are already 16 kHz mono PCM, so no FFmpeg round-trip is needed.
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
    settings?: Partial<SenseVoiceAsrSettings>,
  ) {
    if (!['zh', 'en'].includes(language))
      throw new AppError('只支持中文或英文识别。');
    signal.throwIfAborted();
    const normalized = await this.normalize(audio, contentType, signal);
    const { pcm } = readPcmWav(normalized.bytes);
    const model = await this.model(settings);
    const requested = languageCode(language, settings);
    return this.serialize(async () => {
      signal.throwIfAborted();
      const recognizer = await this.ensure(model, requested);
      signal.throwIfAborted();
      const stream = recognizer.createStream();
      stream.acceptWaveform({
        samples: toFloat32Pcm(pcm),
        sampleRate: SAMPLE_RATE,
      });
      // Decoding runs in the native thread pool, so the world loop keeps ticking.
      const text = (await recognizer.decodeAsync(stream)).text
        .replace(/\s+/g, ' ')
        .trim();
      if (!text)
        throw new AppError('没有识别到文字，请重试。', 400, 'no-speech');
      if (text.length > MAX_TEXT)
        throw new AppError(`识别超过 ${MAX_TEXT} 字，请分成更短的句子。`);
      return text;
    });
  }

  /** One ONNX session decodes a single sentence at a time. */
  private serialize<T>(task: () => Promise<T>) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
