import { expect, it, vi } from 'vitest';
import { AgentSpeechPlayback } from './agent-speech-playback';
import type { AgentSpeechEvent } from '@voxel/shared';
const event = (id = 'clip'): AgentSpeechEvent => ({
  id,
  actor: 'ai',
  text: '你好',
  scope: 'public',
  durationMs: 1000,
  expiresAt: Date.now() + 60000,
});
function setup() {
  const speaker = {
    id: 'ai',
    kind: 'ai-agent',
    name: 'AI',
    connected: true,
    voiceReplies: true,
    x: 0,
    y: 2,
    z: 0,
    yaw: 0,
  };
  const self = { id: 'me', x: 0, y: 2, z: -1, yaw: 0 };
  const link = {
    status: 'connected',
    players: [speaker],
    self,
    chatToken: 'private-token',
  };
  let listening = true;
  const gains: (ReturnType<typeof node> & {
      gain: ReturnType<typeof param>;
    })[] = [],
    pans: (ReturnType<typeof node> & { pan: ReturnType<typeof param> })[] = [],
    sources: (ReturnType<typeof node> & {
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
    })[] = [];
  const param = () => ({ value: 0, setTargetAtTime: vi.fn() });
  const node = () => ({
    connect: vi.fn().mockReturnThis(),
    disconnect: vi.fn(),
  });
  const context = {
    state: 'running',
    currentTime: 0,
    destination: {},
    decodeAudioData: vi.fn(async (): Promise<unknown> => ({})),
    createBufferSource: () => {
      const source = {
        ...node(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null,
      };
      sources.push(source);
      return source;
    },
    createGain: () => {
      const gain = { ...node(), gain: param() };
      gains.push(gain);
      return gain;
    },
    createStereoPanner: () => {
      const pan = { ...node(), pan: param() };
      pans.push(pan);
      return pan;
    },
  };
  const fetchAudio = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      ({ ok: true, arrayBuffer: async () => new ArrayBuffer(10) }) as Response,
  );
  const changed = vi.fn();
  const player = new AgentSpeechPlayback(
    link as unknown as ConstructorParameters<typeof AgentSpeechPlayback>[0],
    () => context as unknown as AudioContext,
    () => listening,
    changed,
    fetchAudio,
  );
  return {
    player,
    speaker,
    self,
    link,
    context,
    fetchAudio,
    changed,
    gains,
    pans,
    sources,
    mute() {
      listening = false;
      player.update();
    },
  };
}
it('loads with auth, starts once, and updates volume/pan as players move and turn', async () => {
  const s = setup();
  s.player.receive(event());
  s.player.receive(event());
  await vi.waitFor(() => expect(s.sources[0]?.start).toHaveBeenCalledTimes(1));
  expect(s.fetchAudio).toHaveBeenCalledTimes(1);
  expect(s.fetchAudio.mock.calls[0][1]?.headers).toEqual({
    Authorization: 'Bearer private-token',
  });
  expect(s.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, 0.04);
  s.speaker.yaw = Math.PI;
  s.player.update();
  expect(s.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(
    0.35,
    0,
    0.04,
  );
  s.self.x = 4;
  s.player.update();
  expect(s.pans[0].pan.setTargetAtTime.mock.lastCall![0]).toBeLessThan(0);
  s.self.z = 30;
  s.player.update();
  expect(s.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, 0.04);
  s.mute();
  expect(s.sources[0].stop).toHaveBeenCalled();
  expect(s.sources[0].disconnect).toHaveBeenCalled();
});
it('drops queued clips on mute and stops when the speaker disables voice or disconnects', async () => {
  const s = setup();
  s.player.receive(event());
  s.player.receive(event('queued'));
  await vi.waitFor(() => expect(s.sources.length).toBe(1));
  s.speaker.voiceReplies = false;
  s.player.update();
  expect(s.sources[0].stop).toHaveBeenCalled();
  expect(s.fetchAudio).toHaveBeenCalledTimes(1);
  s.mute();
  s.player.receive(event('muted'));
  expect(s.fetchAudio).toHaveBeenCalledTimes(1);
});
it('a late decode after muting cannot start audio, and historical/expired events are ignored', async () => {
  const s = setup();
  let resolve!: (buffer: unknown) => void;
  s.context.decodeAudioData.mockImplementation(
    () => new Promise((r) => (resolve = r)),
  );
  s.player.receive({ ...event(), expiresAt: Date.now() - 1 });
  expect(s.fetchAudio).not.toHaveBeenCalled();
  s.player.receive(event());
  await vi.waitFor(() => expect(s.context.decodeAudioData).toHaveBeenCalled());
  s.mute();
  resolve({});
  await new Promise((r) => setTimeout(r, 0));
  expect(s.sources).toHaveLength(0);
});
it('cleans up a failed source start and can play the next reply', async () => {
  const s = setup();
  const create = s.context.createBufferSource;
  s.context.createBufferSource = () => {
    const source = create();
    source.start.mockImplementationOnce(() => {
      throw Error('start failed');
    });
    s.context.createBufferSource = create;
    return source;
  };
  s.player.receive(event());
  await vi.waitFor(() =>
    expect(s.changed).toHaveBeenCalledWith(undefined, 'start failed'),
  );
  s.player.receive(event('next'));
  await vi.waitFor(() => expect(s.sources[1]?.start).toHaveBeenCalled());
  s.player.stop();
});

it('speaks browser events without audio fetching and stops on mute or leaving hearing range', async () => {
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      constructor(public text: string) {}
    },
  );
  const synth = { getVoices: () => [], speak: vi.fn(), cancel: vi.fn() };
  vi.stubGlobal('speechSynthesis', synth);
  const s = setup();
  try {
    s.player.receive({
      ...event('browser1'),
      browserVoice: { voice: '', speed: 1 },
    });
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(s.fetchAudio).not.toHaveBeenCalled();
    s.self.z = 100;
    s.player.update();
    expect(synth.cancel).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    s.self.z = -1;
    s.player.receive({
      ...event('browser2'),
      browserVoice: { voice: '', speed: 1 },
    });
    expect(synth.speak).toHaveBeenCalledTimes(2);
    s.mute();
    expect(synth.cancel).toHaveBeenCalledTimes(2);
  } finally {
    s.player.stop();
    vi.unstubAllGlobals();
  }
});

it('carries actor and private scope, retains normal completion briefly, and clears on mute', async () => {
  const s = setup();
  s.player.receive({ ...event(), scope: 'private' });
  await vi.waitFor(() => expect(s.sources[0]?.start).toHaveBeenCalled());
  expect(s.changed).toHaveBeenLastCalledWith(
    expect.objectContaining({
      actor: 'ai',
      name: 'AI',
      text: '你好',
      scope: 'private',
      startedAt: expect.any(Number),
    }),
  );
  s.sources[0].onended?.();
  expect(s.changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ actor: 'ai', endedAt: expect.any(Number) }),
  );
  s.mute();
  expect(s.changed).toHaveBeenLastCalledWith(undefined);
});

it('clears the caption on disconnect and does not retain interrupted text', async () => {
  const s = setup();
  s.player.receive(event());
  await vi.waitFor(() => expect(s.sources[0]?.start).toHaveBeenCalled());
  s.link.status = 'disconnected';
  s.player.update();
  expect(s.changed).toHaveBeenLastCalledWith(undefined);
  expect(s.sources[0].stop).toHaveBeenCalled();
});
