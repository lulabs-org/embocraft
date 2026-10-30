// @vitest-environment jsdom
import { act } from 'react';
import type { AsrAssignments } from '@voxel/shared';
import { beforeEach, expect, it, vi } from 'vitest';
import { installReactMount } from '../../../test/helpers/react-mount';
import { voiceApi } from './api';
import {
  chooseAsrService,
  refreshAsrSelections,
  useAsrSelection,
  useAsrSelectionSync,
} from './asr-selection';

const mount = installReactMount();
const whisper = {
  id: 'whisper',
  name: 'Whisper',
  provider: 'whisper' as const,
};
const cloud = { id: 'cloud', name: 'Cloud', provider: 'bailian' as const };
const defaults: AsrAssignments = {
  chat: whisper,
  spatial: whisper,
  clip: whisper,
};
let selection: ReturnType<typeof useAsrSelection>;
function Game() {
  useAsrSelectionSync();
  selection = useAsrSelection('chat');
  return <span>{selection.selected.name}</span>;
}

beforeEach(() => {
  // Also recover the in-memory fallback left by the blocked-storage test.
  chooseAsrService('chat', whisper);
  localStorage.clear();
  vi.spyOn(voiceApi, 'asrAssignments').mockResolvedValue(defaults);
});

it('hydrates an empty browser and refreshes changed server assignments on focus', async () => {
  await mount.render(<Game />);
  expect(selection.selected).toEqual(whisper);
  vi.mocked(voiceApi.asrAssignments).mockResolvedValue({
    ...defaults,
    chat: cloud,
  });
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(selection.selected).toEqual(cloud);
  // A second browser has no previous choices or management session.
  localStorage.clear();
  await act(async () => refreshAsrSelections());
  expect(selection.selected).toEqual(cloud);
  expect(voiceApi.asrAssignments).toHaveBeenCalledTimes(3);
});

it('does not replace a successful admin save with an older in-flight read', async () => {
  let resolve!: (value: AsrAssignments) => void;
  vi.mocked(voiceApi.asrAssignments).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  vi.spyOn(voiceApi, 'assignAsrService').mockResolvedValue({
    ...defaults,
    chat: cloud,
  });
  await mount.render(<Game />);
  await act(async () => {
    expect(await selection.choose(cloud)).toBe(true);
  });
  await act(async () => resolve(defaults));
  expect(selection.selected).toEqual(cloud);
});

it('reports a connection failure distinctly and recovers when the browser comes online', async () => {
  vi.mocked(voiceApi.asrAssignments).mockRejectedValueOnce(
    new Error('读取失败'),
  );
  await mount.render(<Game />);
  expect(selection.selected.id).toBe('');
  expect(selection.error).toBe('读取失败');
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(selection.selected).toEqual(whisper);
  expect(selection.error).toBe('');
});

it('uses server assignments and saves them even when local storage is blocked', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(voiceApi, 'assignAsrService').mockResolvedValue({
    ...defaults,
    chat: cloud,
  });
  await mount.render(<Game />);
  expect(selection.selected).toEqual(whisper);
  await act(async () => {
    expect(await selection.choose(cloud)).toBe(true);
  });
  expect(selection.selected).toEqual(cloud);
});
