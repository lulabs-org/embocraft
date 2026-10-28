import { env } from '../../core/config/env';

/** Deployment settings only: clients cannot choose internal service addresses. */
export function speechEndpoint() {
  const c = env.readSpeech();
  return (c.speechApiUrl?.trim() || 'http://127.0.0.1:8000/v1').replace(
    /\/+$/,
    '',
  );
}
