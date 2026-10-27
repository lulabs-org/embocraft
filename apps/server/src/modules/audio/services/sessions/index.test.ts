import { it, expect, vi, afterEach } from 'vitest';

import { createVoiceProvider } from './index';

import { OllamaVoiceProvider } from './ollama';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('validates configuration and disallows remote endpoints / cloud models', () => {
  expect(() => createVoiceProvider('ollama')).toThrow('本地模型');
  expect(() => createVoiceProvider('unknown')).toThrow('语音提供者');
  expect(() => new OllamaVoiceProvider('small', 'https://example.com')).toThrow(
    '本机',
  );
  expect(() => new OllamaVoiceProvider('model:cloud')).toThrow('本地模型');
});
