import { expect, it } from 'vitest';
import { LiveVoiceStore, type SavedLiveVoice } from './live-voice-store';

const draft = {
  provider: 'openai',
  name: 'Voice',
  model: 'gpt-live-1',
  voice: 'marin',
  apiKey: 'secret',
};
function memory() {
  let values: SavedLiveVoice[] = [];
  return {
    load: async () => structuredClone(values),
    save: async (next: SavedLiveVoice[]) => {
      values = structuredClone(next);
    },
  };
}
it('persists separate live voice services, redacts credentials, and leases active services', async () => {
  const repository = memory(),
    store = new LiveVoiceStore(repository);
  await store.load();
  const saved = await store.save(draft);
  expect(saved).toMatchObject({ provider: 'openai', hasApiKey: true });
  expect(saved).not.toHaveProperty('apiKey');
  await store.save({ ...draft, name: 'Updated', apiKey: '' }, saved.id);
  const restored = new LiveVoiceStore(repository);
  await restored.load();
  expect(restored.get(saved.id)).toMatchObject({
    name: 'Updated',
    apiKey: 'secret',
  });
  const lease = restored.acquire(saved.id);
  await expect(restored.remove(saved.id)).rejects.toThrow('正在使用');
  lease.release();
  lease.release();
  await restored.remove(saved.id);
  expect(restored.list()).toEqual([]);
});
it('rejects invalid or missing credentials and provider changes', async () => {
  const store = new LiveVoiceStore(memory());
  await store.load();
  await expect(store.save({ ...draft, apiKey: '' })).rejects.toThrow('API Key');
  await expect(store.save({ ...draft, model: '../bad' })).rejects.toThrow(
    '模型',
  );
  const saved = await store.save(draft);
  await expect(
    store.save({ ...draft, provider: 'gemini' }, saved.id),
  ).rejects.toThrow('不能更改类型');
});
