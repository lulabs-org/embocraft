import { expect, it, vi } from 'vitest';
import { validateVoiceService } from '../domain/voice-service-validation';
import { SpeechService } from './speech.service';

it('reads the current saved configuration when a resolved synthesizer runs', async () => {
  const first = validateVoiceService({ name: 'Voice', type: 'speaches' });
  let current = first;
  const factory = vi.fn(() => ({
    synthesize: async () => ({ bytes: Buffer.from('audio'), durationMs: 1 }),
  }));
  const service = new SpeechService(async () => current, factory);
  const resolved = await service.synthesizer(first.id);

  current = { ...first, speed: 0.8 };
  await resolved.synthesize('Hello', new AbortController().signal);
  expect(factory).toHaveBeenCalledWith(current);

  current = { ...first, type: 'browser' };
  await expect(
    resolved.synthesize('Hello', new AbortController().signal),
  ).rejects.toThrow('浏览器');
  expect(factory).toHaveBeenCalledOnce();
});

it('shares the concurrency limit between direct and resolved synthesis', async () => {
  const voice = validateVoiceService({ name: 'Voice', type: 'speaches' });
  const pending: Array<() => void> = [];
  const service = new SpeechService(
    async () => voice,
    () => ({
      synthesize: () =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve({ bytes: Buffer.from('audio'), durationMs: 1 }),
          );
        }),
    }),
  );
  const resolved = await service.synthesizer(voice.id);
  const first = service.synthesize(
    voice.id,
    'one',
    new AbortController().signal,
  );
  const second = resolved.synthesize('two', new AbortController().signal);

  await expect(
    service.synthesize(voice.id, 'three', new AbortController().signal),
  ).rejects.toMatchObject({ status: 429 });
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending.forEach((complete) => complete());
  await Promise.all([first, second]);
  await expect(
    service.synthesize('missing', '', new AbortController().signal),
  ).rejects.toThrow('试听文字');
});
