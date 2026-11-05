import { expect, it, vi } from 'vitest';
import { validateVoiceService } from '../domain/voice-service-validation';
import type { SpeechModelQuery } from '../ports';
import { SpeechModelsService } from './speech-models.service';

it('reuses the saved key for the same Speaches endpoint and passes the cancellation signal to discovery', async () => {
  const saved = validateVoiceService({
    name: 'Private Speaches',
    type: 'speaches',
    baseUrl: 'https://speech.example/v1',
    apiKey: 'saved-key',
  });
  const models = [{ id: 'vendor/model', languages: [], voices: [] }];
  const query = vi.fn<SpeechModelQuery>().mockResolvedValue(models);
  const getVoice = vi.fn(async () => saved);
  const service = new SpeechModelsService(getVoice, query);
  const signal = new AbortController().signal;

  await expect(
    service.models(
      { serviceId: saved.id, baseUrl: saved.baseUrl, apiKey: '' },
      signal,
    ),
  ).resolves.toBe(models);
  expect(getVoice).toHaveBeenCalledExactlyOnceWith(saved.id);
  expect(query).toHaveBeenCalledExactlyOnceWith(
    {
      type: 'speaches',
      baseUrl: saved.baseUrl,
      apiKey: 'saved-key',
    },
    signal,
  );
});

it('rejects invalid input and changed endpoints before querying models', async () => {
  const saved = validateVoiceService({
    name: 'Private Speaches',
    type: 'speaches',
    baseUrl: 'https://speech.example/v1',
    apiKey: 'saved-key',
  });
  const query = vi.fn<SpeechModelQuery>();
  const service = new SpeechModelsService(async () => saved, query);
  await expect(service.models({ serviceId: 3 })).rejects.toThrow('ID');
  await expect(
    service.models({
      serviceId: saved.id,
      baseUrl: 'https://other.example/v1',
    }),
  ).rejects.toThrow('重新填写密钥');
  expect(query).not.toHaveBeenCalled();
});

it('passes provider errors and cancellation through the model query', async () => {
  const error = new Error('aborted');
  const controller = new AbortController();
  controller.abort(error);
  const query = vi
    .fn<SpeechModelQuery>()
    .mockImplementation(async (_connection, signal) => {
      signal?.throwIfAborted();
      return [];
    });
  const service = new SpeechModelsService(vi.fn(), query);
  await expect(
    service.models({ baseUrl: 'http://speech/v1' }, controller.signal),
  ).rejects.toBe(error);
  expect(query).toHaveBeenCalledOnce();
});
