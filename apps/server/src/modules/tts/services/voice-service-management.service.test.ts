import { expect, it, vi } from 'vitest';
import { domainEvents } from '../../../core/events/domain-events';
import { validateVoiceService } from '../domain/voice-service-validation';
import type { VoiceServicePersistence } from '../ports';
import { VoiceServiceManagement } from './voice-service-management.service';

it('checks deletion again inside the transaction before removing the voice', async () => {
  const voice = validateVoiceService({ name: 'Voice', type: 'speaches' });
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
