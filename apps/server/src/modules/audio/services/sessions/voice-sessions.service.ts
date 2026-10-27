import { createVoiceProvider } from './index';
import type {
  VoiceEvent,
  VoiceProvider,
  VoiceSession,
} from '../../domain/types';

type SessionEvent = Omit<VoiceEvent, 'provider'> & {
  requestId: string;
  provider: unknown;
};

/** Owns player voice sessions; the room supplies delivery and lifecycle calls. */
export class VoiceSessions {
  private sessions = new Map<string, VoiceSession>();

  constructor(
    private defaultProvider: () => VoiceProvider,
    private selectProvider = createVoiceProvider,
  ) {}

  start(
    owner: string,
    requestId: string,
    payload: { text?: unknown; provider?: unknown } | null | undefined,
    emit: (event: SessionEvent) => void,
  ) {
    if (
      typeof payload?.text !== 'string' ||
      !payload.text.trim() ||
      payload.text.length > 240
    )
      return 'invalid-voice-input';
    this.close(owner);
    let provider;
    try {
      if (
        payload.provider !== undefined &&
        typeof payload.provider !== 'string'
      )
        throw Error('无效语音方案。');
      provider =
        payload.provider === undefined
          ? this.defaultProvider()
          : this.selectProvider(payload.provider);
    } catch (error) {
      emit({
        requestId,
        provider: payload.provider,
        state: 'error',
        turn: 0,
        subtitle: error instanceof Error ? error.message : '语音配置错误。',
      });
      return 'voice-provider-unavailable';
    }
    const voice = provider.create((event) => emit({ ...event, requestId }));
    this.sessions.set(owner, voice);
    voice.push({ kind: 'text', text: payload.text });
  }

  interrupt(owner: string) {
    this.sessions.get(owner)?.interrupt();
  }

  close(owner: string) {
    this.sessions.get(owner)?.close();
    this.sessions.delete(owner);
  }

  dispose() {
    for (const voice of this.sessions.values()) voice.close();
    this.sessions.clear();
  }
}
