import { expect, it } from 'vitest';
import { validateVoiceService } from '../domain/voice-service-validation';
import { BailianTts } from './bailian-tts.adapter';
import { CompatibleTts } from './compatible-tts.adapter';
import { SpeachesTtsAdapter } from './speaches-tts.adapter';
import { createSpeechAdapter } from './speech-adapter-factory';

it('selects the server adapter for each validated service and rejects browser synthesis', () => {
  const common = {
    name: 'Voice',
    model: 'model',
    voice: 'voice',
    apiKey: 'secret',
  };
  expect(
    createSpeechAdapter(validateVoiceService({ ...common, type: 'speaches' })),
  ).toBeInstanceOf(SpeachesTtsAdapter);
  expect(
    createSpeechAdapter(
      validateVoiceService({
        ...common,
        type: 'bailian',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      }),
    ),
  ).toBeInstanceOf(BailianTts);
  expect(
    createSpeechAdapter(
      validateVoiceService({
        ...common,
        type: 'compatible',
        baseUrl: 'https://speech.example/v1',
      }),
    ),
  ).toBeInstanceOf(CompatibleTts);
  expect(() =>
    createSpeechAdapter(
      validateVoiceService({ name: 'Browser', type: 'browser' }),
    ),
  ).toThrow('浏览器');
});
