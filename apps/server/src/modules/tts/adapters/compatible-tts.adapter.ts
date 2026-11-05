import type { VoiceServiceDraft } from '@voxel/shared';
import { normalizeSpeech } from '../../../core/audio/normalize';
import type { SpeechSynthesizer } from '../services/speech-synthesizer';
import { boundedBody } from './bounded-response';

export class CompatibleTts implements SpeechSynthesizer {
  constructor(
    private readonly config: VoiceServiceDraft,
    private readonly request: typeof fetch = fetch,
  ) {}

  async synthesize(text: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const c = this.config;
    const response = await this.request(`${c.baseUrl}/audio/speech`, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: c.model,
        input: text,
        voice: c.voice,
        speed: c.speed,
        response_format: 'wav',
      }),
    });
    return normalizeSpeech(
      await boundedBody(response, 10 * 1024 * 1024),
      signal,
    );
  }
}
