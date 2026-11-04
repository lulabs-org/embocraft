import { expect, it, vi } from 'vitest';
import type { Player } from '@voxel/shared';
import type { SpeechCapture } from '../recording/live-recorder';
import { LiveAgentConversation } from './live-agent-conversation';

it('shares one microphone with nearby Agents and follows arrivals and departures', async () => {
  let frame!: (data: Uint8Array) => void;
  const capture = {
    start: vi.fn(async (fn: typeof frame) => {
      frame = fn;
      return true;
    }),
    stop: vi.fn(),
  };
  const sockets: WebSocket[] = [];
  const connect = () => {
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
      binaryType: '',
      onopen: undefined,
      onmessage: undefined,
      onerror: undefined,
      onclose: undefined,
    } as unknown as WebSocket;
    sockets.push(socket);
    return socket;
  };
  const sources: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    buffer?: AudioBuffer;
    onended?: () => void;
  }[] = [];
  const pan = {
    pan: { setTargetAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const gain = {
    gain: { value: 0, setTargetAtTime: vi.fn() },
    connect: vi.fn(() => pan),
    disconnect: vi.fn(),
  };
  const context = {
    currentTime: 0,
    destination: {},
    createGain: () => gain,
    createStereoPanner: () => pan,
    createBuffer: (_c: number, size: number, rate: number) => ({
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
  const self = {
    id: 'human',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    connected: true,
  } as Player;
  const agent = {
    id: 'agent',
    x: 1,
    y: 0,
    z: 0,
    yaw: 0,
    connected: true,
  } as Player;
  const link = {
    status: 'connected',
    chatToken: 'token',
    self,
    players: [self, agent, { ...agent, id: 'agent2' }],
  };
  const changed = vi.fn(),
    stream = {} as MediaStream;
  const session = new LiveAgentConversation(
    link,
    changed,
    capture as unknown as SpeechCapture,
    connect,
  );
  await session.start(stream, context);
  session.updateAgents([]);
  expect(sockets).toHaveLength(0);
  session.updateAgents([{ id: 'agent', name: 'A' }]);
  session.updateAgents([
    { id: 'agent', name: 'A' },
    { id: 'agent2', name: 'B' },
  ]);
  const [socket, second] = sockets;
  second.onopen?.(new Event('open'));
  second.onmessage?.({
    data: JSON.stringify({ type: 'ready' }),
  } as MessageEvent);
  socket.onopen?.(new Event('open'));
  expect(socket.send).toHaveBeenCalledWith(
    JSON.stringify({ type: 'start', token: 'token', agentId: 'agent' }),
  );
  socket.onmessage?.({
    data: JSON.stringify({ type: 'ready' }),
  } as MessageEvent);
  expect(capture.start).toHaveBeenCalledWith(
    expect.any(Function),
    expect.any(Function),
    stream,
  );
  frame(new Uint8Array([1, 2]));
  expect(socket.send).toHaveBeenCalledWith(new Uint8Array([1, 2]));
  expect(second.send).toHaveBeenCalledWith(new Uint8Array([1, 2]));
  expect(capture.start).toHaveBeenCalledOnce();
  socket.onmessage?.({ data: new ArrayBuffer(4800) } as MessageEvent);
  expect(sources[0].start).toHaveBeenCalledOnce();
  socket.onmessage?.({
    data: JSON.stringify({ type: 'interrupted' }),
  } as MessageEvent);
  expect(sources[0].stop).toHaveBeenCalledOnce();
  session.updateAgents([{ id: 'agent2', name: 'B' }]);
  expect(socket.close).toHaveBeenCalledOnce();
  frame(new Uint8Array([3, 4]));
  expect(socket.send).not.toHaveBeenCalledWith(new Uint8Array([3, 4]));
  expect(second.send).toHaveBeenCalledWith(new Uint8Array([3, 4]));
  session.stop();
  expect(second.close).toHaveBeenCalledOnce();
  expect(session.state.status).toBe('idle');
});
