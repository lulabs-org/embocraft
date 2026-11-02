import type { SpeachesModel } from '@voxel/shared';
import { SpeachesModels } from '../../../../core/audio/speaches-models';
import type { ModelCatalogPort } from '../../ports';

export interface WhisperConnectionConfig {
  baseUrl?: string;
  apiKey?: string;
}

/**
 * 探测与发现 Speaches / Whisper 语音识别模型列表
 */
export class WhisperModelCatalog implements ModelCatalogPort {
  constructor(
    private readonly config: WhisperConnectionConfig = {},
    private readonly request: typeof fetch = fetch,
  ) {}

  async list(signal?: AbortSignal): Promise<SpeachesModel[]> {
    return new SpeachesModels(this.config, this.request).list(
      signal,
      'automatic-speech-recognition',
    );
  }
}

export async function listWhisperModels(
  config: WhisperConnectionConfig,
  signal?: AbortSignal,
  request?: typeof fetch,
): Promise<SpeachesModel[]> {
  return new WhisperModelCatalog(config, request).list(signal);
}

