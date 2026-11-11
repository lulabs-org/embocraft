import type WebSocket from 'ws';
import type {
  BailianAsrDraft,
  SenseVoiceAsrSettings,
  SpeachesModel,
  WhisperAsrDraft,
} from '@voxel/shared';
import type { SavedService } from './domain/model';

export interface BatchTranscribeOptions {
  contentType: string;
  language: string;
  signal: AbortSignal;
  settings?: WhisperAsrDraft;
}

export interface EngineStatus {
  available: boolean;
  reason?: string;
}

/** 项目服务器自行运行的引擎所接受的配置；云端配置使用各自的传输通道。 */
export type SpeechSettings = WhisperAsrDraft | SenseVoiceAsrSettings;

/**
 * 进程内识别引擎：Whisper 走 HTTP，SenseVoice 走 sherpa-onnx。
 * 聊天录音与附近语音字幕共用该接口，具体配置由路由器匹配。
 */
export interface SpeechTranscriberPort {
  readonly provider: 'whisper' | 'sense-voice';
  status(
    settings?: SpeechSettings,
    signal?: AbortSignal,
  ): Promise<EngineStatus>;
  normalize(
    audio: Buffer,
    contentType: string,
    signal: AbortSignal,
  ): Promise<{ bytes: Buffer; durationMs: number }>;
  transcribe(
    audio: Buffer,
    contentTypeOrOptions: string | BatchTranscribeOptions,
    language?: string,
    signal?: AbortSignal,
    settings?: SpeechSettings,
  ): Promise<string>;
}

/** 向后兼容的别名；批量识别接口现已覆盖本地 SenseVoice。 */
export type BatchTranscriberPort = SpeechTranscriberPort;

/**
 * 实时流式音频识别引擎端口 (例如 阿里云百炼 DashScope)
 */
export interface StreamingAsrPort {
  readonly provider: 'bailian';
  bridge(client: WebSocket, settings: BailianAsrDraft, language: string): void;
}

/**
 * 模型目录发现与探活端口
 */
export interface ModelCatalogPort {
  list(signal?: AbortSignal): Promise<SpeachesModel[]>;
}

/**
 * ASR 服务配置仓储持久化端口
 */
export interface AsrRepositoryPort {
  load(): Promise<SavedService[]>;
  update<T>(
    change: (values: SavedService[]) => { values: SavedService[]; result: T },
  ): Promise<T>;
}
