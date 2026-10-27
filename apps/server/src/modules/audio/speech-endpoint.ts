import { env } from '../../core/config/env';
/** Deployment settings only: clients cannot choose internal service addresses. */
export function speechEndpoint(engine: 'whisper' | 'piper') {
  const c = env.readSpeech();
  const urls =
    engine === 'whisper'
      ? [c.whisperApiUrl, c.speechApiUrl]
      : [c.piperApiUrl, c.speechApiUrl, c.whisperApiUrl];
  return (
    urls.map((url) => url?.trim()).find(Boolean) || 'http://127.0.0.1:8000/v1'
  ).replace(/\/+$/, '');
}
