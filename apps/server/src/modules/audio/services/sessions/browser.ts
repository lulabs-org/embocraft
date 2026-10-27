import type {
  VoiceEvent,
  VoiceProvider,
  VoiceSession,
} from '../../domain/types';

export class BrowserVoiceProvider implements VoiceProvider {
  readonly id = 'browser';
  create(emit: (event: VoiceEvent) => void): VoiceSession {
    let turn = 0,
      closed = false;
    return {
      push(input) {
        if (closed) return;
        turn++;
        if (
          input.kind !== 'text' ||
          !input.text.trim() ||
          input.text.length > 240
        ) {
          emit({
            provider: 'browser',
            state: 'error',
            turn,
            subtitle: '请输入 1–240 字文字；音频识别由浏览器完成。',
          });
          return;
        }
        emit({
          provider: 'browser',
          state: 'idle',
          turn,
          subtitle: `语音回声（非 AI）：${input.text}`,
          speakText: input.text,
        });
      },
      interrupt() {
        if (!closed)
          emit({
            provider: 'browser',
            state: 'interrupted',
            turn: ++turn,
            subtitle: '已打断。',
          });
      },
      close() {
        closed = true;
      },
    };
  }
}
