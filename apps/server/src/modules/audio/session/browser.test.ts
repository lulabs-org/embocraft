import { it, expect, vi, afterEach } from 'vitest';

import { BrowserVoiceProvider } from './browser';

import type { VoiceEvent } from '../domain/types';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('offers real playback text without pretending the browser echo is AI', () => {
  const events: VoiceEvent[] = [];
  const s = new BrowserVoiceProvider().create((e) => events.push(e));
  s.push({ kind: 'text', text: '你好' });
  expect(events[0]).toMatchObject({ state: 'idle', speakText: '你好' });
  expect(events[0].subtitle).toContain('非 AI');
  s.close();
  s.push({ kind: 'text', text: 'ignored' });
  expect(events).toHaveLength(1);
});
