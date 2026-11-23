import { expect, it } from 'vitest';
import {
  MIMO_CLONE_SAMPLE_MAX_CHARS,
  MIMO_TTS_CLONE_MODEL,
  MIMO_TTS_MODEL,
} from '@voxel/shared';
import { validateVoiceService } from './voice-service-validation';

const sample = `data:audio/wav;base64,${'A'.repeat(64)}`;

const clone = (patch: Record<string, unknown> = {}) => ({
  name: 'Clone',
  type: 'mimo',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  apiKey: 'key',
  model: MIMO_TTS_CLONE_MODEL,
  voice: sample,
  speed: 1,
  ...patch,
});

it('keeps a base64 sample for the MiMo clone model', () => {
  expect(validateVoiceService(clone()).voice).toBe(sample);
});

it('rejects a preset voice ID under the clone model', () => {
  expect(() => validateVoiceService(clone({ voice: '冰糖' }))).toThrow(
    '请上传 mp3 或 wav 格式的克隆样本',
  );
});

it('rejects a clone sample beyond the MiMo 10 MB base64 limit', () => {
  const oversized = `data:audio/wav;base64,${'A'.repeat(
    MIMO_CLONE_SAMPLE_MAX_CHARS + 128,
  )}`;
  expect(() => validateVoiceService(clone({ voice: oversized }))).toThrow(
    '克隆样本不能超过 10 MB',
  );
});

it('reuses the saved clone sample when the draft leaves the voice blank', () => {
  const previous = validateVoiceService(clone());
  const entry = validateVoiceService({ ...clone(), voice: '' }, previous);
  expect(entry.voice).toBe(sample);
});

it('does not reuse a preset voice as a clone sample', () => {
  const previous = validateVoiceService(
    clone({ model: MIMO_TTS_MODEL, voice: '冰糖' }),
  );
  expect(() => validateVoiceService({ ...clone(), voice: '' }, previous)).toThrow(
    '请上传 mp3 或 wav 格式的克隆样本',
  );
});

it('still accepts MiMo preset voices under the preset model', () => {
  expect(
    validateVoiceService(clone({ model: MIMO_TTS_MODEL, voice: '冰糖' })).voice,
  ).toBe('冰糖');
});
