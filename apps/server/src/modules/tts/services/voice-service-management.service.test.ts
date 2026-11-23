import { expect, it, vi } from 'vitest';
import { MIMO_TTS_CLONE_MODEL, MIMO_TTS_MODEL } from '@voxel/shared';
import { domainEvents } from '../../../core/events/domain-events';
import { validateVoiceService } from '../domain/voice-service-validation';
import type { VoiceServicePersistence } from '../ports';
import { VoiceServiceManagement } from './voice-service-management.service';

it('hides clone samples from the public view while keeping preset voices', async () => {
  const base = {
    type: 'mimo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    apiKey: 'key',
    speed: 1,
  };
  const preset = validateVoiceService({
    ...base,
    name: 'Preset',
    model: MIMO_TTS_MODEL,
    voice: '冰糖',
  });
  const clone = validateVoiceService({
    ...base,
    name: 'Clone',
    model: MIMO_TTS_CLONE_MODEL,
    voice: 'data:audio/wav;base64,AAAA',
  });
  const voices = [preset, clone];
  const storage: VoiceServicePersistence = {
    load: async () => voices,
    get: async (id) => voices.find((voice) => voice.id === id),
    transaction: async () => {
      throw new Error('unused');
    },
  };
  const list = await new VoiceServiceManagement(storage).list();
  expect(list.map((voice) => voice.voice)).toEqual(['冰糖', '']);
});

it('checks deletion again inside the transaction before removing the voice', async () => {
  const voice = validateVoiceService({
    voice: 'huayan',
    name: 'Voice',
    type: 'speaches',
  });
  const remove = vi.fn();
  let inTransaction = false;
  const storage: VoiceServicePersistence = {
    load: async () => [voice],
    get: async () => voice,
    transaction: async (run) => {
      inTransaction = true;
      try {
        return await run({
          get: async () => voice,
          count: async () => 1,
          create: async () => {},
          update: async () => {},
          remove,
        });
      } finally {
        inTransaction = false;
      }
    },
  };
  const checks: boolean[] = [];
  const changed = vi.fn();
  const releaseGuard = domainEvents.on('tts.service.removing', () => {
    checks.push(inTransaction);
    if (inTransaction) throw new Error('voice became referenced');
  });
  const releaseChanged = domainEvents.on('tts.service.changed', changed);
  try {
    await expect(
      new VoiceServiceManagement(storage).remove(voice.id),
    ).rejects.toThrow('voice became referenced');
    expect(checks).toEqual([false, true]);
    expect(remove).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  } finally {
    releaseGuard();
    releaseChanged();
  }
});
