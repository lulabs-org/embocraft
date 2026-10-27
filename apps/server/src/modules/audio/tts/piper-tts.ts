import { DEFAULT_PIPER_MODEL } from '@voxel/shared';
import { validatePcmWav } from '../domain/pcm-wav';
import { AppError } from '../../../core/errors/app-error';
import { piperModel } from './piper-models';
import { speechEndpoint } from '../speech-endpoint';
import type { SpeechSynthesizer } from './speech-synthesizer';

export class PiperTts implements SpeechSynthesizer {
  constructor(
    private options: { model?: string; speed?: number } = {},
    private endpoint = speechEndpoint('piper'),
    private request: typeof fetch = fetch,
  ) {}
  async synthesize(text: string, signal: AbortSignal) {
    if (!text.trim() || text.length > 240)
      throw new AppError('语音文字需为 1–240 字。');
    const model = piperModel(this.options.model || DEFAULT_PIPER_MODEL);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
    try {
      bounded.throwIfAborted();
      const response = await this.request(`${this.endpoint}/audio/speech`, {
        method: 'POST',
        signal: bounded,
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model.id,
          input: text,
          voice: model.voice,
          speed: this.options.speed ?? 1,
          response_format: 'wav',
          sample_rate: 16000,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          response.status === 404
            ? 'Piper 模型未安装，请在控制台安装所选模型。'
            : `Piper 合成失败（HTTP ${response.status}），请检查语音服务。`,
          502,
        );
      }
      if (!response.body) throw new AppError('Piper 未返回音频。', 502);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 3 * 1024 * 1024)
            throw new AppError('Piper 音频过大。', 502);
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      bounded.throwIfAborted();
      const bytes = Buffer.concat(chunks);
      try {
        return { bytes, durationMs: validatePcmWav(bytes, 90.5) };
      } catch {
        throw new AppError(
          'Piper 未生成有效语音，请确认文字与模型语言匹配。',
          502,
        );
      }
    } catch (error) {
      if (signal.aborted || error instanceof AppError) throw error;
      throw new AppError(
        bounded.aborted
          ? 'Piper 合成超时，请重试。'
          : '无法连接 Piper，请检查 speech 容器。',
        502,
      );
    }
  }
}
