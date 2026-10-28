import type { VoiceProvider } from '../../domain/types';
import { MockVoiceProvider } from './mock';
import { BrowserVoiceProvider } from './browser';
import { OllamaVoiceProvider } from './ollama';

export type {
  VoiceState,
  VoiceEvent,
  VoiceInput,
  VoiceSession,
  VoiceProvider,
} from '../../domain/types';
export { MockVoiceProvider } from './mock';
export { BrowserVoiceProvider } from './browser';
export { OllamaVoiceProvider } from './ollama';

export function createVoiceProvider(
  id = 'mock',
  config: { ollamaModel: string; ollamaBaseUrl?: string } = { ollamaModel: '' },
): VoiceProvider {
  switch (id) {
    case 'mock':
      return new MockVoiceProvider();
    case 'browser':
      return new BrowserVoiceProvider();
    case 'ollama':
      return new OllamaVoiceProvider(config.ollamaModel, config.ollamaBaseUrl);
    default:
      throw Error('语音提供者仅支持 mock、browser 或 ollama。');
  }
}
