import type {
  OfflineRecognizerConfig,
  OfflineRecognizerResult,
  Waveform,
} from 'sherpa-onnx-node';
import type { SenseVoiceAsrSettings } from '@voxel/shared';
import { env } from '../../../../core/config/env';
import { AppError } from '../../../../core/errors/app-error';
import {
  audioFormats,
  MAX_AUDIO_BYTES,
  normalizeRecording,
} from '../../../../core/audio/normalize';
import { readPcmWav } from '../../../../core/audio/pcm-wav';
import { runCommand, type CommandRunner } from '../../../../core/audio/command';
import type {
  BatchTranscribeOptions,
  EngineStatus,
  SpeechSettings,
  SpeechTranscriberPort,
} from '../../ports';
import {
  listSenseVoiceModels,
  resolveSenseVoiceModel,
  senseVoiceRoot,
  type SenseVoiceModel,
} from './sense-voice.models';

const SAMPLE_RATE = 16000;
const MAX_TEXT = 240;

/** sherpa-onnx 离线识别器的精简视图，便于测试注入替身。 */
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
  // CommonJS 互操作会把导出对象直接暴露，或挂在 default 下。
  return namespace.OfflineRecognizer ? namespace : namespace.default!;
}

/** 已保存配置优先；没有配置时回退到游戏的中/英文选择。 */
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
 * 基于 sherpa-onnx 的本地离线语音识别（SenseVoice）。
 * 所有请求共用一个 ONNX 会话：加载 int8 图会占用数百 MB，因此切换语言时
 * 直接更新已加载的会话，而不是再创建一个识别器。
 */
export class SenseVoiceAdapter implements SpeechTranscriberPort {
  readonly provider = 'sense-voice' as const;
  private recognizer?: SenseVoiceDecoder;
  private loading?: Promise<SenseVoiceDecoder>;
  private loadedModel?: string;
  private config?: OfflineRecognizerConfig;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private modelRoot = senseVoiceRoot(),
    private threads = env.readSpeech().asrThreads,
    private runner: CommandRunner = runCommand,
    private loadSherpa: () => Promise<SherpaOfflineModule> = loadSherpaModule,
  ) {}

  /** 会话由模型目录决定，与服务级配置无关。 */
  private async model(settings?: Partial<SenseVoiceAsrSettings>) {
    return resolveSenseVoiceModel(settings?.model ?? 'default', this.modelRoot);
  }

  /** 就绪检查只验证模型文件；计算图在首次识别时才加载。 */
  async status(
    settings?: SpeechSettings,
    _signal?: AbortSignal,
  ): Promise<EngineStatus> {
    try {
      const model = await this.model(settings as SenseVoiceAsrSettings);
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
  }

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

  /** 可以放心调用：它只改写已加载计算图中的语言条件标记。 */
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
    // 浏览器上传的快照已是 16 kHz 单声道 PCM，无需再经过 FFmpeg 转换。
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
      'ffmpeg',
      this.runner,
    );
  }

  /** 同时接受选项对象和调度器使用的按位置传参形式。 */
  async transcribe(
    audio: Buffer,
    contentTypeOrOptions: string | BatchTranscribeOptions,
    language?: string,
    signal?: AbortSignal,
    settings?: SpeechSettings,
  ) {
    const options =
      typeof contentTypeOrOptions === 'string'
        ? {
            contentType: contentTypeOrOptions,
            language: language!,
            signal: signal!,
            settings: settings as SenseVoiceAsrSettings | undefined,
          }
        : {
            ...contentTypeOrOptions,
            settings: contentTypeOrOptions.settings as
              | SenseVoiceAsrSettings
              | undefined,
          };
    if (!['auto', 'zh', 'en'].includes(options.language))
      throw new AppError('只支持自动、中文或英文识别。');
    options.signal.throwIfAborted();
    const normalized = await this.normalize(
      audio,
      options.contentType,
      options.signal,
    );
    const { pcm } = readPcmWav(normalized.bytes);
    const model = await this.model(options.settings);
    const requested = languageCode(options.language, options.settings);
    return this.serialize(async () => {
      options.signal.throwIfAborted();
      const recognizer = await this.ensure(model, requested);
      options.signal.throwIfAborted();
      const stream = recognizer.createStream();
      stream.acceptWaveform({
        samples: toFloat32Pcm(pcm),
        sampleRate: SAMPLE_RATE,
      });
      // 解码在原生线程池中执行，世界循环不会被阻塞。
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

  /** 一个 ONNX 会话一次只解码一句话。 */
  private serialize<T>(task: () => Promise<T>) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
