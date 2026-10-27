// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import {
  chooseAsrService,
  initializeAsrSelections,
  syncAsrChoice,
  toAsrChoice,
} from './asr-selection';

beforeEach(() => localStorage.clear());

it('keeps chat, nearby and recorded voice choices independent and stores no provider secret', () => {
  const provider = {
    id: 'bailian-one',
    name: 'Alibaba',
    provider: 'bailian' as const,
    apiKey: 'secret',
  };
  chooseAsrService('chat', provider);
  chooseAsrService('spatial', {
    id: 'whisper-one',
    name: 'Whisper',
    provider: 'whisper',
  });
  chooseAsrService('clip', {
    id: 'recording-whisper',
    name: 'Recording Whisper',
    provider: 'whisper',
  });
  expect(JSON.parse(localStorage.getItem('voxel.asr-selection.v2')!)).toEqual({
    chat: { id: 'bailian-one', name: 'Alibaba', provider: 'bailian' },
    spatial: { id: 'whisper-one', name: 'Whisper', provider: 'whisper' },
    clip: {
      id: 'recording-whisper',
      name: 'Recording Whisper',
      provider: 'whisper',
    },
  });
  syncAsrChoice('bailian-one');
  expect(
    JSON.parse(localStorage.getItem('voxel.asr-selection.v2')!).spatial.id,
  ).toBe('whisper-one');
  expect(
    JSON.parse(localStorage.getItem('voxel.asr-selection.v2')!).chat.id,
  ).toBe('');
  syncAsrChoice('recording-whisper');
  expect(
    JSON.parse(localStorage.getItem('voxel.asr-selection.v2')!).clip.id,
  ).toBe('');
});

it('does not retain a realtime-only service for recorded voice', () => {
  chooseAsrService('clip', {
    id: 'realtime',
    name: 'Realtime ASR',
    provider: 'bailian',
  });
  expect(
    JSON.parse(localStorage.getItem('voxel.asr-selection.v2')!).clip.id,
  ).toBe('');
});

it('treats the former server default as unselected', () => {
  expect(
    toAsrChoice({ id: '', name: '服务器默认识别', provider: 'whisper' }),
  ).toEqual({ id: '', name: '', provider: 'whisper' });
});

const builtInWhisper = {
  id: 'saved-whisper-id',
  name: '自托管 Whisper',
  provider: 'whisper' as const,
};

it('selects the saved self-hosted Whisper profile for all three unset uses', () => {
  initializeAsrSelections([
    { id: 'ali-id', name: '阿里云识别', provider: 'bailian' },
    builtInWhisper,
  ]);
  expect(JSON.parse(localStorage.getItem('voxel.asr-selection.v2')!)).toEqual({
    chat: builtInWhisper,
    spatial: builtInWhisper,
    clip: builtInWhisper,
  });
});

it('preserves explicit choices and fills only missing uses', () => {
  const selected = {
    id: 'browser-id',
    name: '浏览器中文识别',
    provider: 'browser' as const,
  };
  chooseAsrService('chat', selected);
  initializeAsrSelections([builtInWhisper]);
  expect(JSON.parse(localStorage.getItem('voxel.asr-selection.v2')!)).toEqual({
    chat: selected,
    spatial: builtInWhisper,
    clip: builtInWhisper,
  });
  initializeAsrSelections([
    { id: 'other', name: '另一个 Whisper', provider: 'whisper' },
  ]);
  expect(
    JSON.parse(localStorage.getItem('voxel.asr-selection.v2')!).chat,
  ).toEqual(selected);
});
