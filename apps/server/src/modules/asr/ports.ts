import type WebSocket from 'ws';
import type {
  BailianAsrDraft,
  SenseVoiceAsrDraft,
  SpeachesModel,
  WhisperAsrDraft,
} from '@voxel/shared';
import type { SavedService } from './domain/model';

export interface BatchTranscribeOptions {
  contentType: string;
  language: string;
  signal: AbortSignal;
  settings?: SpeechSettings;
}

export interface EngineStatus {
  available: boolean;
  reason?: string;
}

/** 服务器可选的批处理引擎配置；云端实时服务使用各自的传输通道。 */
export type SpeechSettings = WhisperAsrDraft | SenseVoiceAsrDraft;

/**
 * 批处理语音识别引擎：Whisper 与 SenseVoice 都请求外部 HTTP 服务。
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

/** 向后兼容的别名；批处理识别接口同时覆盖 Whisper 与 SenseVoice。 */
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
