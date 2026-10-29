// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClipRecorder } from './clip-recorder';

class FakeMediaRecorder {
  static last: FakeMediaRecorder;
  static isTypeSupported() {
    return true;
  }
  state = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeMediaRecorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop = vi.fn(() => {
    this.state = 'inactive';
  });
  data(value: string) {
    this.ondataavailable?.({ data: new Blob([value]) });
  }
}
let clip: ClipRecorder;
const stopTrack = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  stopTrack.mockClear();
  const capture = vi.fn(
    async () =>
      ({ getTracks: () => [{ stop: stopTrack }] }) as unknown as MediaStream,
  );
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: capture } });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('Blob', NodeBlob);
  clip = new ClipRecorder(capture);
});
afterEach(() => {
  clip.cancel();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('includes the final dataavailable chunk before reporting completion', async () => {
  const done = vi.fn(),
    error = vi.fn();
  await clip.start(done, error, vi.fn());
  const media = FakeMediaRecorder.last;
  media.data('first');
  await vi.advanceTimersByTimeAsync(6000);
  clip.finish();
  clip.finish();
  expect(media.stop).toHaveBeenCalledOnce();
  expect(done).not.toHaveBeenCalled();
  media.data('last');
  media.onstop?.();
  expect(done).toHaveBeenCalledOnce();
  expect(await (done.mock.calls[0][0] as Blob).text()).toBe('firstlast');
  expect(done.mock.calls[0][1]).toBe(6000);
  expect(error).not.toHaveBeenCalled();
  expect(stopTrack).toHaveBeenCalled();
});

it('stops at 20 seconds but still waits for the final audio event', async () => {
  const done = vi.fn();
  await clip.start(done, vi.fn(), vi.fn());
  const media = FakeMediaRecorder.last;
  await vi.advanceTimersByTimeAsync(19999);
  expect(media.stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(media.stop).toHaveBeenCalledOnce();
  expect(done).not.toHaveBeenCalled();
  media.data('full');
  media.onstop?.();
  expect(done).toHaveBeenCalledOnce();
  expect(await (done.mock.calls[0][0] as Blob).text()).toBe('full');
});

it.each(['cancel', 'error'] as const)(
  'ignores trailing events after %s',
  async (kind) => {
    const done = vi.fn(),
      error = vi.fn();
    await clip.start(done, error, vi.fn());
    const old = FakeMediaRecorder.last;
    old.data('initial');
    clip.finish();
    if (kind === 'cancel') clip.cancel();
    else old.onerror?.();
    old.data('late');
    old.onstop?.();
    expect(done).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(kind === 'error' ? 1 : 0);
  },
);

it('reports an empty completed recording as an error', async () => {
  const done = vi.fn(),
    error = vi.fn();
  await clip.start(done, error, vi.fn());
  clip.finish();
  FakeMediaRecorder.last.onstop?.();
  expect(done).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith('录音为空，请重试。');
});
