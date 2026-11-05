import { AppError } from '../../../core/errors/app-error';
import { PiperTts } from './piper.service';
import { RemoteTts } from './remote.service';
import type { SpeechSynthesizer } from './speech-synthesizer';
import type { SavedVoice } from '../persistence/voice-service-types';

export class VoiceRuntime {
  private deleting = new Set<string>();
  private bindings = new Map<string, string>();
  private pendingBindings = new Map<string, symbol>();
  private listeners = new Set<(actor: string) => void>();
  private running = 0;

  constructor(
    private readonly load: (id: string) => Promise<SavedVoice>,
    private readonly factory: (value: SavedVoice) => SpeechSynthesizer = (
      value,
    ) =>
      value.type === 'speaches' ? new PiperTts(value) : new RemoteTts(value),
  ) {}

  async get(id: string) {
    if (this.deleting.has(id))
      throw new AppError('语音服务不存在，请重新选择。', 404);
    const value = await this.load(id);
    if (this.deleting.has(id))
      throw new AppError('语音服务不存在，请重新选择。', 404);
    return value;
  }

  async remove(
    id: string,
    isUsed: () => boolean,
    remove: (assertUnused: () => void) => Promise<void>,
  ) {
    const assertUnused = () => {
      if (isUsed() || [...this.bindings.values()].includes(id))
        throw new AppError(
          '有 Agent 正在引用此服务或保存参数，请先完成更新，并在编辑参数中更换或移除语音服务。',
          409,
        );
    };
    assertUnused();
    this.deleting.add(id);
    try {
      await remove(assertUnused);
    } finally {
      this.deleting.delete(id);
    }
  }

  serviceChanged(id: string) {
    for (const [actor, service] of this.bindings)
      if (service === id) this.changed(actor);
  }

  onChange(listener: (actor: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(actor: string) {
    for (const listener of this.listeners) listener(actor);
  }

  async bind(actor: string, id: string) {
    const pending = Symbol();
    this.pendingBindings.set(actor, pending);
    try {
      if (id) await this.get(id);
      if (this.pendingBindings.get(actor) !== pending) return;
      if (id && this.deleting.has(id))
        throw new AppError('语音服务不存在，请重新选择。', 404);
      if (this.bindings.get(actor) === id) return;
      this.changed(actor);
      this.bindings.set(actor, id);
    } finally {
      if (this.pendingBindings.get(actor) === pending)
        this.pendingBindings.delete(actor);
    }
  }
  unbind(actor: string) {
    this.pendingBindings.delete(actor);
    this.changed(actor);
    this.bindings.delete(actor);
  }

  async forActor(actor: string): Promise<SpeechSynthesizer> {
    // Only trusted Agent management binds cloud services; raw world actions cannot select them.
    const id = this.bindings.get(actor);
    if (id === undefined) return new PiperTts();
    const entry = id ? await this.get(id) : undefined;
    if (this.bindings.get(actor) !== id)
      throw new AppError('语音服务绑定已变更。', 409);
    return {
      ...(entry?.type === 'browser'
        ? {
            browserVoice: {
              voice: entry.voice,
              speed: entry.speed,
              voiceLanguage: entry.voiceLanguage,
            },
          }
        : {}),
      synthesize: (text, signal) => this.synthesize(id, text, signal),
    };
  }

  async synthesize(id: string, text: string, signal: AbortSignal) {
    if (typeof text !== 'string' || !text.trim() || text.length > 240)
      throw new AppError('试听文字需为 1–240 字。');
    if (this.running >= 2)
      throw new AppError('语音服务繁忙，请稍后重试。', 429);
    this.running++;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
    try {
      bounded.throwIfAborted();
      const entry = await this.get(id);
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
