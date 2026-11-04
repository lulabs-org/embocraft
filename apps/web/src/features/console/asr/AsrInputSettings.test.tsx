// @vitest-environment jsdom
import { act } from 'react';
import type { AsrServiceView } from '@voxel/shared';
import { beforeEach, expect, it, vi } from 'vitest';
import { installReactMount } from '../../../../test/helpers/react-mount';
import { voiceApi } from '../../voice/api';
import { chooseAsrService } from '../../voice/asr-selection';
import { AsrInputSettings } from './AsrInputSettings';

const mount = installReactMount();
const whisper = {
  id: 'whisper-id',
  name: '自托管 Whisper',
  provider: 'whisper' as const,
};
const other = {
  id: 'other-id',
  name: '另一识别服务',
  provider: 'whisper' as const,
};

beforeEach(() => {
  localStorage.clear();
  chooseAsrService('spatial', whisper);
  vi.spyOn(voiceApi, 'asrAssignments').mockResolvedValue({
    chat: whisper,
    spatial: whisper,
    clip: whisper,
  });
  vi.spyOn(voiceApi, 'assignAsrService').mockResolvedValue({
    chat: whisper,
    spatial: other,
    clip: whisper,
  });
  vi.spyOn(voiceApi, 'listAsrServices').mockResolvedValue([
    whisper,
    other,
  ] as AsrServiceView[]);
});

it('keeps a changed service pending until saved, then updates only that use', async () => {
  await mount.render(<AsrInputSettings active />);
  const select = mount.host.querySelector<HTMLSelectElement>(
    '.asr-input-controls select',
  )!;
  const save = mount.host.querySelector<HTMLButtonElement>(
    '.asr-input-controls > button',
  )!;
  expect(save.disabled).toBe(true);

  await act(async () => {
    select.value = other.id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(save.disabled).toBe(false);
  expect(
    JSON.parse(localStorage.getItem('voxel.asr-selection.v2')!).spatial.id,
  ).toBe(whisper.id);
  expect(
    mount.host.querySelector('.console-sidebar-item small')!.textContent,
  ).toBe(whisper.name);

  await act(async () => save.click());
  expect(voiceApi.assignAsrService).toHaveBeenCalledWith(
    'spatial',
    other.id,
    expect.any(AbortSignal),
  );
  const saved = JSON.parse(localStorage.getItem('voxel.asr-selection.v2')!);
  expect(saved.spatial.id).toBe(other.id);
  expect(saved.chat.id).toBe(whisper.id);
  expect(saved.clip.id).toBe(whisper.id);
  expect(save.disabled).toBe(true);
  expect(
    mount.host.querySelector('.console-sidebar-item small')!.textContent,
  ).toBe(other.name);
});

it('keeps the old assignment and pending draft when the server rejects saving', async () => {
  vi.mocked(voiceApi.assignAsrService).mockRejectedValue(new Error('无法保存'));
  await mount.render(<AsrInputSettings active />);
  const select = mount.host.querySelector<HTMLSelectElement>(
    '.asr-input-controls select',
  )!;
  const save = mount.host.querySelector<HTMLButtonElement>(
    '.asr-input-controls > button',
  )!;
  await act(async () => {
    select.value = other.id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => save.click());
  expect(select.value).toBe(other.id);
  expect(save.disabled).toBe(false);
  expect(mount.host.textContent).toContain('无法保存');
  expect(
    JSON.parse(localStorage.getItem('voxel.asr-selection.v2')!).spatial.id,
  ).toBe(whisper.id);
});

it('configures nearby voice mode in the console and retains it in this browser', async () => {
  await mount.render(<AsrInputSettings active />);
  const mode = mount.host.querySelector<HTMLSelectElement>(
    '.console-panel > label select',
  )!;
  expect(mode.value).toBe('traditional');
  await act(async () => {
    mode.value = 'live';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(localStorage.getItem('voxel.spatial-voice-mode')).toBe('live');
  expect(mount.host.querySelector('.asr-input-controls')).toBeNull();
  await mount.render(<AsrInputSettings active />);
  expect(
    mount.host.querySelector<HTMLSelectElement>(
      '.console-panel > label select',
    )!.value,
  ).toBe('live');
});
