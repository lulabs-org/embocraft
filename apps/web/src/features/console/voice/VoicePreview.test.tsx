// @vitest-environment jsdom
import { act } from 'react';

import { expect, it, vi } from 'vitest';

import type { VoiceServiceDraft } from '@voxel/shared';

import { VoicePreview } from './VoicePreview';

import { voiceApi } from './api';

import { installReactMount } from '../../../../test/helpers/react-mount';
const mount = installReactMount();

const draft: VoiceServiceDraft = {
  name: 'MiMo',
  type: 'mimo',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5-tts',
  voice: '冰糖',
  speed: 1,
  apiKey: '',
};

// The preview request carries the draft itself, so unsaved edits are audible.
it('previews the current draft and aborts it with the mounted player on cleanup', async () => {
  const create = vi.fn(() => 'blob:preview');
  const revoke = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  const preview = vi
    .spyOn(voiceApi, 'previewVoice')
    .mockResolvedValue(new Blob(['audio']));
  await mount.render(<VoicePreview serviceId="voice-a" draft={draft} active />);
  await act(async () => {
    mount.host.querySelector('button')!.click();
  });
  expect(preview.mock.calls[0][0]).toEqual({
    serviceId: 'voice-a',
    draft,
    text: expect.any(String),
  });
  const signal = preview.mock.calls[0][1]!;
  const player = mount.host.querySelector('audio')!;
  expect(player.getAttribute('src')).toBe('blob:preview');
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
  const pause = vi.spyOn(player, 'pause');
  await mount.unmount();
  expect(signal.aborted).toBe(true);
  expect(pause).toHaveBeenCalled();
  expect(revoke).toHaveBeenCalledWith('blob:preview');
});
