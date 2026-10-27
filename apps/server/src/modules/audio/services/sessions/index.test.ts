import { it, expect, vi, afterEach } from 'vitest';

import { createVoiceProvider } from './index';

import { OllamaVoiceProvider } from './ollama';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('validates configuration and disallows remote endpoints / cloud models', () => {
  vi.stubEnv('OLLAMA_MODEL', '');
  expect(() => createVoiceProvider('ollama')).toThrow('OLLAMA_MODEL');
  expect(() => createVoiceProvider('unknown')).toThrow('VOICE_PROVIDER');
  expect(() => new OllamaVoiceProvider('small', 'https://example.com')).toThrow(
    '本机',
  );
  expect(() => new OllamaVoiceProvider('model:cloud')).toThrow('本地模型');
});
