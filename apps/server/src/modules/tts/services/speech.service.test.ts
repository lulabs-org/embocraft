import { expect, it, vi } from 'vitest';
import { AppError } from '../../../core/errors/app-error';
import { validateVoiceService } from '../domain/voice-service-validation';
import { SpeechService } from './speech.service';

it('reads the current saved configuration when a resolved synthesizer runs', async () => {
  const first = validateVoiceService({
    voice: 'huayan',
    name: 'Voice',
    type: 'speaches',
  });
  let current = first;
  const factory = vi.fn(() => ({
    synthesize: async () => ({ bytes: Buffer.from('audio'), durationMs: 1 }),
  }));
  const service = new SpeechService(async () => current, factory);
  const resolved = await service.synthesizer(first.id);

  if (resolved.kind !== 'server') throw new Error('expected server speech');
  current = { ...first, speed: 0.8 };
  await resolved.synthesizer.synthesize('Hello', new AbortController().signal);
  expect(factory).toHaveBeenCalledWith(current);

  current = { ...first, type: 'browser' };
  await expect(
    resolved.synthesizer.synthesize('Hello', new AbortController().signal),
  ).rejects.toThrow('浏览器');
  expect(factory).toHaveBeenCalledOnce();
});

it('shares the concurrency limit between direct and resolved synthesis', async () => {
  const voice = validateVoiceService({
    voice: 'huayan',
    name: 'Voice',
    type: 'speaches',
  });
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
  if (resolved.kind !== 'server') throw new Error('expected server speech');
  const first = service.synthesize(
    voice.id,
    'one',
    new AbortController().signal,
  );
  const second = resolved.synthesizer.synthesize(
    'two',
    new AbortController().signal,
  );

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

it('returns browser parameters without exposing server synthesis', async () => {
  const voice = validateVoiceService({
    name: 'Browser',
    type: 'browser',
    voice: 'voice',
    voiceLanguage: 'en-US',
    speed: 1.2,
  });
  const factory = vi.fn();
  const service = new SpeechService(async () => voice, factory);
  expect(await service.synthesizer(voice.id)).toEqual({
    kind: 'browser',
    voice: { voice: 'voice', voiceLanguage: 'en-US', speed: 1.2 },
  });
  expect(factory).not.toHaveBeenCalled();
});

it('uses the latest saved server configuration and fails if it was deleted', async () => {
  const voice = validateVoiceService({
    voice: 'huayan',
    name: 'Voice',
    type: 'speaches',
  });
  let current = voice;
  let deleted = false;
  const factory = vi.fn(() => ({
    synthesize: async () => ({ bytes: Buffer.from('audio'), durationMs: 1 }),
  }));
  const service = new SpeechService(async () => {
    if (deleted) throw new AppError('语音服务不存在。', 404);
    return current;
  }, factory);
  const resolved = await service.synthesizer(voice.id);
  if (resolved.kind !== 'server') throw new Error('expected server speech');
  current = { ...voice, voice: 'new-voice' };
  await resolved.synthesizer.synthesize('hello', new AbortController().signal);
  expect(factory).toHaveBeenCalledWith(current);
  deleted = true;
  await expect(
    resolved.synthesizer.synthesize('hello', new AbortController().signal),
  ).rejects.toMatchObject({ status: 404 });
  expect(factory).toHaveBeenCalledOnce();
});

it('does not start synthesis after cancellation while reading configuration', async () => {
  const voice = validateVoiceService({
    voice: 'huayan',
    name: 'Voice',
    type: 'speaches',
  });
  let release!: () => void;
  const factory = vi.fn();
  const service = new SpeechService(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return voice;
  }, factory);
  const controller = new AbortController();
  const result = service.synthesize(voice.id, 'hello', controller.signal);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  controller.abort();
  release();
  await expect(result).rejects.toThrow();
  expect(factory).not.toHaveBeenCalled();
});
