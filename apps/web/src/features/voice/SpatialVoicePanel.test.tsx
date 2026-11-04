// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { setSpatialVoiceMode } from './spatial-mode';
import type { Connection } from '../../network/connection';
import { installReactMount } from '../../../test/helpers/react-mount';
import { SpatialVoicePanel } from './SpatialVoicePanel';
import { voiceApi } from './api';

const calls = vi.hoisted(() => ({
  transcribe: vi.fn(),
  transcribeStop: vi.fn(),
  liveStart: vi.fn(),
  liveStop: vi.fn(),
  updateAgents: vi.fn(),
  translate: (key: string) => key,
}));
vi.mock('../../i18n', () => ({ useI18n: () => ({ t: calls.translate }) }));
vi.mock('./asr-selection', () => ({
  useAsrSelection: () => ({ selected: { id: 'asr' } }),
}));
vi.mock('../../audio', () => ({
  SpatialTranscriber: class {
    start = calls.transcribe;
    stop = calls.transcribeStop;
  },
  SpatialVoice: class {
    state = {
      sending: false,
      listening: false,
      pending: false,
      connected: 0,
      error: '',
    };
    liveMicrophone = {} as MediaStream;
    liveAudioContext = {} as AudioContext;
    onMicrophone = (_stream?: MediaStream) => {};
    signal = () => {};
    agentSpeech = { receive: () => {} };
    constructor(
      _connection: unknown,
      private changed: (state: unknown) => void,
    ) {}
    async setListening(value: boolean) {
      this.state.listening = value;
      this.changed({ ...this.state });
    }
    async startMic() {
      this.state.sending = true;
      this.changed({ ...this.state });
      this.onMicrophone(this.liveMicrophone);
    }
    stopMic = () => {
      this.state.sending = false;
      this.onMicrophone(undefined);
      this.changed({ ...this.state });
    };
    update() {}
    dispose() {}
  },
}));
vi.mock('../../audio/spatial/live-agent-conversation', () => ({
  LiveAgentConversation: class {
    start = calls.liveStart.mockResolvedValue(undefined);
    stop = calls.liveStop;
    updateAgents = calls.updateAgents;
    update() {}
  },
}));
const mount = installReactMount();
const connection = {
  status: 'connected',
  chatToken: 'token',
  players: [],
  chatRecording: false,
} as unknown as Connection;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

it('switches exclusively between traditional and live modes without requiring an Agent selection', async () => {
  vi.spyOn(voiceApi, 'liveAgents').mockResolvedValue([]);
  await mount.render(
    <SpatialVoicePanel connection={connection} speechAnchor={() => null} />,
  );
  const mic = () =>
    mount.host.querySelector<HTMLButtonElement>(
      'button[aria-label^="voice.mic"]',
    )!;
  expect(mount.host.querySelector('select')).toBeNull();
  await act(async () => mic().click());
  expect(calls.transcribe).toHaveBeenCalledOnce();
  await act(async () => {
    setSpatialVoiceMode('live');
  });
  expect(calls.transcribeStop).toHaveBeenCalled();
  await act(async () => mic().click());
  expect(calls.liveStart).toHaveBeenCalledOnce();
  expect(calls.transcribe).toHaveBeenCalledOnce();
  expect(mount.host.textContent).toContain('voice.liveWaiting');
  await act(async () => {
    setSpatialVoiceMode('traditional');
  });
  expect(calls.liveStop).toHaveBeenCalled();
  await act(async () => mic().click());
  expect(calls.transcribe).toHaveBeenCalledTimes(2);
});

it('shows a discovery failure instead of claiming there are no Agents', async () => {
  vi.spyOn(voiceApi, 'liveAgents').mockRejectedValue(new Error('offline'));
  await mount.render(
    <SpatialVoicePanel connection={connection} speechAnchor={() => null} />,
  );
  await act(async () => {
    setSpatialVoiceMode('live');
  });
  await act(async () =>
    mount.host
      .querySelector<HTMLButtonElement>('button[aria-label^="voice.mic"]')!
      .click(),
  );
  expect(mount.host.querySelector('[role="alert"]')?.textContent).toContain(
    'offline',
  );
});

it('distinguishes a nearby unavailable Agent from an empty area', async () => {
  vi.spyOn(voiceApi, 'liveAgents').mockResolvedValue([]);
  const player = { id: 'player', x: 0, y: 0, z: 0, yaw: 0, connected: true };
  const nearby = {
    ...connection,
    self: player,
    players: [{ ...player, id: 'agent', kind: 'ai-agent', z: -1 }],
  } as unknown as Connection;
  await mount.render(
    <SpatialVoicePanel connection={nearby} speechAnchor={() => null} />,
  );
  await act(async () => {
    setSpatialVoiceMode('live');
  });
  await act(async () =>
    mount.host
      .querySelector<HTMLButtonElement>('button[aria-label^="voice.mic"]')!
      .click(),
  );
  expect(mount.host.textContent).toContain('voice.liveUnconfigured');
  expect(mount.host.textContent).not.toContain('voice.liveWaiting');
});
