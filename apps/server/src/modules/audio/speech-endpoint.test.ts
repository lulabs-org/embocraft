import { afterEach, expect, it, vi } from 'vitest';

import { speechEndpoint } from './speech-endpoint';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('resolves SPEECH_API_URL and default fallback', () => {
  vi.stubEnv('SPEECH_API_URL', '  ');
  expect(speechEndpoint()).toBe('http://127.0.0.1:8000/v1');
  vi.stubEnv('SPEECH_API_URL', 'http://speech/v1/');
  expect(speechEndpoint()).toBe('http://speech/v1');
});
