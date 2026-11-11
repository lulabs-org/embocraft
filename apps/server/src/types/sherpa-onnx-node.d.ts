/**
 * sherpa-onnx Node 绑定的最小类型声明，该包只提供普通 JavaScript 实现。
 * 这里仅声明本服务器使用的离线 ASR 接口。
 * @see https://k2-fsa.github.io/sherpa/onnx/python/index.html
 */
declare module 'sherpa-onnx-node' {
  export type Waveform = { samples: Float32Array; sampleRate: number };

  export type OfflineRecognizerConfig = {
    featConfig?: { sampleRate?: number; featureDim?: number };
    modelConfig?: {
      senseVoice?: {
        model?: string;
        language?: string;
        useInverseTextNormalization?: number;
      };
      transducer?: {
        encoder?: string;
        decoder?: string;
        joiner?: string;
      };
      tokens?: string;
      numThreads?: number;
      provider?: string;
      debug?: number | boolean;
    };
  };

  export type OfflineRecognizerResult = {
    text: string;
    tokens?: string[];
    timestamps?: number[];
    lang?: string;
    emotion?: string;
    event?: string;
  };

  export class OfflineStream {
    acceptWaveform(waveform: Waveform): void;
    setOption(key: string, value: string): void;
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    static createAsync(
      config: OfflineRecognizerConfig,
    ): Promise<OfflineRecognizer>;
    createStream(hotwords?: string): OfflineStream;
    setConfig(config: OfflineRecognizerConfig): void;
    decode(stream: OfflineStream): void;
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
    getResult(stream: OfflineStream): OfflineRecognizerResult;
  }

  export function readWave(path: string): Waveform;

  export const version: string;
}
