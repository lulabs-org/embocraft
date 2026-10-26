import { afterEach, expect, it, vi } from 'vitest';
import { chooseBrowserVoice, speakBrowserText } from './browser-tts';

afterEach(() => vi.unstubAllGlobals());
const voices = [
  { name: 'Chinese', lang: 'zh-CN', localService: true },
  { name: 'English', lang: 'en-US', localService: true },
] as SpeechSynthesisVoice[];
it('prefers the configured voice and falls back by language on another device', () => {
  expect(
    chooseBrowserVoice(voices, { voice: 'English', speed: 1 }, '你好'),
  ).toBe(voices[1]);
  expect(
    chooseBrowserVoice(
      voices,
      { voice: 'Missing', voiceLanguage: 'en-GB', speed: 1 },
      '你好',
    ),
  ).toBe(voices[1]);
  expect(chooseBrowserVoice(voices, { voice: '', speed: 1 }, '你好')).toBe(
    voices[0],
  );
});
it('completes browser playback and cancels only the current owner', async () => {
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      constructor(public text: string) {}
    },
  );
  const utterances: SpeechSynthesisUtterance[] = [];
  const synth = {
    getVoices: () => voices,
    cancel: vi.fn(),
    speak: (u: SpeechSynthesisUtterance) => utterances.push(u),
  };
  vi.stubGlobal('speechSynthesis', synth);
  const first = new AbortController(),
    second = new AbortController();
  const a = speakBrowserText(
    '你好',
    { voice: '', speed: 0.9 },
    first.signal,
  ).catch((e) => e.name);
  const b = speakBrowserText(
    'Hello',
    { voice: 'English', speed: 1.2 },
    second.signal,
    0.5,
  );
  expect(await a).toBe('AbortError');
  expect(synth.cancel).toHaveBeenCalledTimes(1);
  first.abort();
  expect(synth.cancel).toHaveBeenCalledTimes(1);
  expect(utterances[1]).toMatchObject({
    text: 'Hello',
    voice: voices[1],
    rate: 1.2,
    volume: 0.5,
  });
  utterances[1].onend?.({} as SpeechSynthesisEvent);
  await b;
  const third = new AbortController();
  const c = speakBrowserText(
    '停止',
    { voice: '', speed: 1 },
    third.signal,
  ).catch((e) => e.name);
  third.abort();
  expect(await c).toBe('AbortError');
  expect(synth.cancel).toHaveBeenCalledTimes(2);
});
it('reports unsupported browsers and synthesis failures', async () => {
  vi.stubGlobal('speechSynthesis', undefined);
  await expect(
    speakBrowserText(
      'hello',
      { voice: '', speed: 1 },
      new AbortController().signal,
    ),
  ).rejects.toThrow('不支持');
  vi.stubGlobal('SpeechSynthesisUtterance', class {});
  vi.stubGlobal('speechSynthesis', {
    getVoices: () => [],
    cancel: vi.fn(),
    speak: (u: SpeechSynthesisUtterance) =>
      u.onerror?.({ error: 'not-allowed' } as SpeechSynthesisErrorEvent),
  });
  await expect(
    speakBrowserText(
      'hello',
      { voice: '', speed: 1 },
      new AbortController().signal,
    ),
  ).rejects.toThrow('not-allowed');
});
