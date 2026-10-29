// @vitest-environment jsdom
import { act } from 'react';

import { expect, it, vi } from 'vitest';

import { AudioPlayer } from './AudioPlayer';

import { installReactMount } from '../../../../test/helpers/react-mount';
const mount = installReactMount();

it('ignores an audio source that resolves after the player has unmounted', async () => {
  let resolve!: (url: string) => void;
  const loadSource = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  await mount.render(<AudioPlayer loadSource={loadSource} durationMs={1000} />);
  await act(async () => {
    mount.host.querySelector('button')!.click();
  });
  expect(loadSource).toHaveBeenCalledOnce();
  await mount.unmount();
  await act(async () => {
    resolve('blob:late');
  });
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
});

it('preserves play, pause, seek and duration in the inline draft player', async () => {
  const { VoiceDraft } = await import('./VoiceDraft');
  await mount.render(
    <VoiceDraft src="blob:preview" durationMs={10000} busy={false} />,
  );
  const audio = mount.host.querySelector('audio')!;
  const button = mount.host.querySelector('button')!;
  const seek = mount.host.querySelector('input')!;
  expect(mount.host.querySelector('.audio-time')?.textContent).toBe(
    '0:00 / 0:10',
  );
  await act(async () => button.click());
  expect(audio.play).toHaveBeenCalledOnce();
  await act(async () => {
    Object.defineProperty(audio, 'paused', {
      value: false,
      configurable: true,
    });
    audio.dispatchEvent(new Event('play'));
    audio.currentTime = 3;
    audio.dispatchEvent(new Event('timeupdate'));
  });
  expect(mount.host.querySelector('.audio-time')?.textContent).toBe(
    '0:03 / 0:10',
  );
  await act(async () => button.click());
  expect(audio.pause).toHaveBeenCalled();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(seek, '500');
    seek.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(audio.currentTime).toBe(5);
  expect(seek.getAttribute('aria-valuetext')).toBe('0:05 / 0:10');
  await mount.render(<VoiceDraft src="blob:preview" durationMs={10000} busy />);
  expect(button.disabled).toBe(true);
  expect(seek.disabled).toBe(true);
});
