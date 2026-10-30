// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  chooseAsrService,
  refreshAsrSelections,
  syncAsrChoice,
  toAsrChoice,
} from './asr-selection';

import { voiceApi } from './api';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

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

it('loads server assignments in a fresh browser and replaces stale remote cache', async () => {
  const assignments = {
    chat: builtInWhisper,
    spatial: builtInWhisper,
    clip: builtInWhisper,
  };
  vi.spyOn(voiceApi, 'asrAssignments').mockResolvedValue(assignments);
  await refreshAsrSelections();
  expect(JSON.parse(localStorage.getItem('voxel.asr-selection.v2')!)).toEqual(
    assignments,
  );
  chooseAsrService('chat', { id: 'deleted', name: 'Old', provider: 'bailian' });
  await refreshAsrSelections();
  expect(
    JSON.parse(localStorage.getItem('voxel.asr-selection.v2')!).chat,
  ).toEqual(builtInWhisper);
});

it('preserves a personal browser engine override while syncing server assignments', async () => {
  const local = {
    id: 'browser-id',
    name: '浏览器中文',
    provider: 'browser' as const,
  };
  chooseAsrService('chat', local);
  vi.spyOn(voiceApi, 'asrAssignments').mockResolvedValue({
    chat: builtInWhisper,
    spatial: builtInWhisper,
    clip: builtInWhisper,
  });
  await refreshAsrSelections();
  expect(JSON.parse(localStorage.getItem('voxel.asr-selection.v2')!)).toEqual({
    chat: local,
    spatial: builtInWhisper,
    clip: builtInWhisper,
  });
});
