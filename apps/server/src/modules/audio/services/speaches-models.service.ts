import type { SpeachesModel, SpeachesVoice } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import { speechEndpoint } from '../speech-endpoint';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('shape');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 200): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    [...value].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw Error('shape');
  return value.trim();
}

/** Discovers installed models only; never downloads or installs a model. */
export class SpeachesModels {
  constructor(
    private config: { baseUrl?: string; apiKey?: string } = {},
    private request: typeof fetch = fetch,
  ) {}

  async list(
    signal?: AbortSignal,
    task: 'text-to-speech' | 'automatic-speech-recognition' = 'text-to-speech',
  ): Promise<SpeachesModel[]> {
    const bounded = AbortSignal.any([
      AbortSignal.timeout(5000),
      ...(signal ? [signal] : []),
    ]);
    try {
      bounded.throwIfAborted();
      const endpoint = (
        this.config.baseUrl?.trim() || speechEndpoint()
      ).replace(/\/+$/, '');
      const response = await this.request(`${endpoint}/models?task=${task}`, {
        signal: bounded,
        redirect: 'error',
        headers: this.config.apiKey
          ? { Authorization: `Bearer ${this.config.apiKey}` }
          : {},
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          response.status === 401 || response.status === 403
            ? '无法获取 Speaches 模型，请检查 API Key 和访问权限。'
            : `无法获取 Speaches 模型（HTTP ${response.status}），请检查服务地址。`,
          502,
        );
      }
      if (!response.body) throw Error('shape');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1024 * 1024) throw Error('size');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      bounded.throwIfAborted();
      const data = record(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      ).data;
      if (!Array.isArray(data)) throw Error('shape');
      const models = new Map<string, SpeachesModel>();
      for (const item of data) {
        const raw = record(item);
        if (raw.task !== task) continue;
        const id = text(raw.id);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/.test(id)) throw Error('shape');
        const languages =
          raw.language === undefined
            ? []
            : (Array.isArray(raw.language) ? raw.language : [raw.language]).map(
                (value) => text(value, 40),
              );
        if (raw.voices !== undefined && !Array.isArray(raw.voices))
          throw Error('shape');
        const voices = new Map<string, SpeachesVoice>();
        for (const value of (raw.voices ?? []) as unknown[]) {
          const voice = record(value);
          const voiceId = text(voice.id ?? voice.name);
          voices.set(voiceId, {
            id: voiceId,
            name: text(voice.name ?? voiceId),
            ...(voice.language ? { language: text(voice.language, 40) } : {}),
          });
        }
        models.set(id, { id, languages, voices: [...voices.values()] });
      }
      return [...models.values()];
    } catch (error) {
      if (signal?.aborted || error instanceof AppError) throw error;
      throw new AppError(
        bounded.aborted
          ? '获取 Speaches 模型超时，请重试。'
          : '无法读取 Speaches 模型列表，请检查服务地址、连接和响应格式。',
        502,
      );
    }
  }
}
