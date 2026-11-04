import { expect, it, vi } from 'vitest';
import type { Player } from '@voxel/shared';
import { LiveAgentPlayback } from './live-agent-playback';

it('plays PCM chunks in order, follows spatial position, and discards queued audio on interruption', () => {
  const sources: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    buffer?: AudioBuffer;
    onended?: () => void;
  }[] = [];
  const gain = {
    gain: { value: 0, setTargetAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const pan = {
    pan: { setTargetAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  gain.connect.mockReturnValue(pan);
  const context = {
    currentTime: 10,
    destination: {},
    createGain: () => gain,
    createStereoPanner: () => pan,
    createBuffer: (_channels: number, size: number, rate: number) => ({
      duration: size / rate,
      getChannelData: () => new Float32Array(size),
    }),
    createBufferSource: () => {
      const source = {
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
        connect: vi.fn(),
        buffer: undefined,
        onended: undefined,
      };
      sources.push(source);
      return source;
    },
  } as unknown as AudioContext;
  const player = new LiveAgentPlayback(context);
  const listener = { id: 'p', x: 0, y: 0, z: 0, yaw: 0 } as Player;
  const agent = { id: 'a', x: 1, y: 0, z: 0 } as Player;
  player.update(listener, agent);
  expect(gain.gain.setTargetAtTime).toHaveBeenCalled();
  player.append(new ArrayBuffer(4800), 24000);
  player.append(new ArrayBuffer(4800), 24000);
  expect(sources[0].start).toHaveBeenCalledWith(10);
  expect(sources[1].start).toHaveBeenCalledWith(10.1);
  player.interrupt();
  expect(sources[0].stop).toHaveBeenCalledOnce();
  expect(sources[1].stop).toHaveBeenCalledOnce();
  player.append(new ArrayBuffer(4800), 24000);
  expect(sources[2].start).toHaveBeenCalledWith(10);
  player.dispose();
  expect(sources[2].stop).toHaveBeenCalledOnce();
});
