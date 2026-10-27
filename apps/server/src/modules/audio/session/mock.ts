import type {
  VoiceEvent,
  VoiceProvider,
  VoiceSession,
  VoiceState,
} from '../domain/types';

export class MockVoiceProvider implements VoiceProvider {
  readonly id = 'mock-text-no-audio';
  create(emit: (event: VoiceEvent) => void): VoiceSession {
    let turn = 0,
      closed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const clear = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
    const send = (state: VoiceState, subtitle = '', error?: string) => {
      if (!closed) emit({ provider: this.id, state, turn, subtitle, error });
    };
    const later = (ms: number, fn: () => void) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!closed) fn();
      }, ms);
      timers.add(timer);
    };
    return {
      push(input) {
        if (closed) return;
        clear();
        turn++;
        if (input.kind === 'audio') {
          send('error', '', 'mock-does-not-process-audio');
          return;
        }
        if (!input.text.trim() || input.text.length > 240) {
          send('error', '', 'invalid-text');
          return;
        }
        send('listening', `[Mock input] ${input.text}`);
        later(150, () =>
          send('thinking', '[Mock] Preparing scripted response…'),
        );
        const reply = `[Mock — not AI, no audio] You said: ${input.text}`;
        later(450, () =>
          send('speaking', reply.slice(0, Math.ceil(reply.length / 2))),
        );
        later(950, () => send('speaking', reply));
        later(1800, () => send('idle', reply));
      },
      interrupt() {
        if (closed) return;
        clear();
        turn++;
        send('interrupted', '[Mock] Response interrupted.');
      },
      close() {
        clear();
        closed = true;
      },
    };
  }
}
