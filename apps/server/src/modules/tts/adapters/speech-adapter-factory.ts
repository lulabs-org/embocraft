import { AppError } from '../../../core/errors/app-error';
import type { SavedVoice } from '../domain/voice-service-validation';
import type { SpeechSynthesizer } from '../services/speech-synthesizer';
import { BailianTts } from './bailian-tts.adapter';
import { CompatibleTts } from './compatible-tts.adapter';
import { SpeachesTtsAdapter } from './speaches-tts.adapter';

export function createSpeechAdapter(value: SavedVoice): SpeechSynthesizer {
  switch (value.type) {
    case 'speaches':
      return new SpeachesTtsAdapter(value);
    case 'bailian':
      return new BailianTts(value);
    case 'compatible':
      return new CompatibleTts(value);
    case 'browser':
      throw new AppError('此服务由浏览器朗读，请在浏览器中试听。');
  }
}
