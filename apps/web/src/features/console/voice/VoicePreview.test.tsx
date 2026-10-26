// @vitest-environment jsdom
import { act } from 'react';

import { expect, it, vi } from 'vitest';

import { VoicePreview } from './VoicePreview';

import { voiceApi } from './api';

import { installReactMount } from '../../../../test/helpers/react-mount';
const mount = installReactMount();

it('aborts the latest voice preview and stops its mounted player on cleanup', async () => {
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
  await mount.render(<VoicePreview serviceId="voice-a" active />);
  await act(async () => {
    mount.host.querySelector('button')!.click();
  });
  const signal = preview.mock.calls[0][2]!;
  const player = mount.host.querySelector('audio')!;
  expect(player.getAttribute('src')).toBe('blob:preview');
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
  const pause = vi.spyOn(player, 'pause');
  await mount.unmount();
  expect(signal.aborted).toBe(true);
  expect(pause).toHaveBeenCalled();
  expect(revoke).toHaveBeenCalledWith('blob:preview');
});
