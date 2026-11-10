import { AppError } from '../../../core/errors/app-error';
import type { SavedVoice } from '../domain/voice-service-validation';
import type { SpeechAdapterFactory } from '../ports';
import type { ResolvedSpeech } from './speech-synthesizer';

export class SpeechService {
  private running = 0;

  constructor(
    private readonly getVoice: (id: string) => Promise<SavedVoice>,
    private readonly factory: SpeechAdapterFactory,
  ) {}

  async synthesizer(id: string): Promise<ResolvedSpeech> {
    const entry = await this.getVoice(id);
    if (entry.type === 'browser') {
      return {
        kind: 'browser',
        voice: {
          voice: entry.voice,
          speed: entry.speed,
          voiceLanguage: entry.voiceLanguage,
        },
      };
    }
    return {
      kind: 'server',
      synthesizer: {
        synthesize: (text, signal) => this.synthesize(id, text, signal),
      },
    };
  }

  /** Synthesize with the saved configuration resolved for this service. */
  async synthesize(id: string, text: string, signal: AbortSignal) {
    this.checkText(text);
    const entry = await this.getVoice(id);
    return this.run(entry, text, signal);
  }

  /** Synthesize with an unsaved draft configuration; nothing is persisted. */
  async preview(entry: SavedVoice, text: string, signal: AbortSignal) {
    this.checkText(text);
    return this.run(entry, text, signal);
  }

  /** Saved and draft speech share one limit; Agent replies stay within it too. */
  private checkText(text: string) {
    if (typeof text !== 'string' || !text.trim() || text.length > 240)
      throw new AppError('试听文字需为 1–240 字。');
  }

  /** Shared synthesis path: concurrency cap, timeout, and sanitized errors. */
  private async run(entry: SavedVoice, text: string, signal: AbortSignal) {
    if (this.running >= 2)
      throw new AppError('语音服务繁忙，请稍后重试。', 429);
    this.running++;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
    try {
      bounded.throwIfAborted();
      if (entry.type === 'browser')
        throw new AppError('此服务由浏览器朗读，请在浏览器中试听。');
      const result = await this.factory(entry).synthesize(text, bounded);
      bounded.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted || error instanceof AppError) throw error;
      throw new AppError(
        bounded.aborted
          ? '语音合成超时，请重试。'
          : '语音合成失败，请检查服务配置和音频转换工具。',
        502,
      );
    } finally {
      this.running--;
    }
  }
}
