import { env } from '../config/env';

/** Deployment default; managed TTS profiles can override their own endpoint. */
export function speechEndpoint() {
  const c = env.readSpeech();
  return (c.speechApiUrl?.trim() || 'http://127.0.0.1:8000/v1').replace(
    /\/+$/,
    '',
  );
}
