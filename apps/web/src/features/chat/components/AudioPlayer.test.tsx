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
