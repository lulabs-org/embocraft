import type WebSocket from 'ws';
import type {
  BailianAsrDraft,
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

/**
 * 批处理/文件音频识别引擎端口 (例如 Whisper / Speaches)
 */
export interface BatchTranscriberPort {
  readonly provider: 'whisper';
  status(
    settings?: WhisperAsrDraft,
    signal?: AbortSignal,
  ): Promise<EngineStatus>;
  transcribe(
    audio: Buffer,
    contentTypeOrOptions: string | BatchTranscribeOptions,
    language?: string,
    signal?: AbortSignal,
    settings?: WhisperAsrDraft,
  ): Promise<string>;
}

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
  save(values: SavedService[]): Promise<void>;
}
