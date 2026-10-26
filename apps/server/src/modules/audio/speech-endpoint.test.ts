import { afterEach, expect, it, vi } from 'vitest';

import { speechEndpoint } from './speech-endpoint';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('resolves engine overrides, shared URL, legacy Piper fallback and blank values', () => {
  for (const key of ['WHISPER_API_URL', 'PIPER_API_URL', 'SPEECH_API_URL'])
    vi.stubEnv(key, '  ');
  expect(speechEndpoint('whisper')).toBe('http://127.0.0.1:8000/v1');
  vi.stubEnv('WHISPER_API_URL', 'http://legacy/v1/');
  expect(speechEndpoint('piper')).toBe('http://legacy/v1');
  vi.stubEnv('SPEECH_API_URL', 'http://speech/v1');
  expect(speechEndpoint('piper')).toBe('http://speech/v1');
  expect(speechEndpoint('whisper')).toBe('http://legacy/v1');
  vi.stubEnv('PIPER_API_URL', 'http://piper/v1');
  expect(speechEndpoint('piper')).toBe('http://piper/v1');
});
