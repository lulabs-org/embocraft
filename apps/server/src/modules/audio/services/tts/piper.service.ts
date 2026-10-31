import { DEFAULT_PIPER_MODEL, PIPER_MODELS } from '@voxel/shared';
import { validatePcmWav } from '../../domain/pcm-wav';
import { AppError } from '../../../../core/errors/app-error';
import { speechEndpoint } from '../../speech-endpoint';
import type { SpeechSynthesizer } from './speech-synthesizer';

export class PiperTts implements SpeechSynthesizer {
  constructor(
    private options: {
      model?: string;
      voice?: string;
      speed?: number;
      baseUrl?: string;
      apiKey?: string;
    } = {},
    private endpoint = (options.baseUrl?.trim() || speechEndpoint()).replace(
      /\/+$/,
      '',
    ),
    private request: typeof fetch = fetch,
  ) {}
  async synthesize(text: string, signal: AbortSignal) {
    if (!text.trim() || text.length > 240)
      throw new AppError('语音文字需为 1–240 字。');
    const model = this.options.model || DEFAULT_PIPER_MODEL;
    const voice =
      this.options.voice ||
      PIPER_MODELS.find((item) => item.id === model)?.voice;
    if (!voice) throw new AppError('请选择 Speaches 模型支持的音色。');
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
    try {
      bounded.throwIfAborted();
      const response = await this.request(`${this.endpoint}/audio/speech`, {
        method: 'POST',
        signal: bounded,
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.apiKey
            ? { Authorization: `Bearer ${this.options.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model,
          input: text,
          voice,
          speed: this.options.speed ?? 1,
          response_format: 'wav',
          sample_rate: 16000,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          response.status === 404
            ? 'Speaches 模型未安装，请检查语音服务的启动日志。'
            : `Speaches 合成失败（HTTP ${response.status}），请检查接口地址和 API Key。`,
          502,
        );
      }
      if (!response.body) throw new AppError('Speaches 未返回音频。', 502);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 3 * 1024 * 1024)
            throw new AppError('Speaches 音频过大。', 502);
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
          'Speaches 未生成有效语音，请确认文字与模型语言匹配。',
          502,
        );
      }
    } catch (error) {
      if (signal.aborted || error instanceof AppError) throw error;
      throw new AppError(
        bounded.aborted
          ? 'Speaches 合成超时，请重试。'
          : '无法连接 Speaches，请检查服务地址和运行状态。',
        502,
      );
    }
  }
}
