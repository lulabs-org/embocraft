import { afterEach, expect, it, vi } from 'vitest';
import type { Player } from '@voxel/shared';
import { domainEvents } from '../src/core/events/domain-events';
import { CharacterVoiceCoordinator } from '../src/modules/ai-characters/services/voice-coordinator.service';
import type { Job } from '../src/modules/ai-characters/services/character-job';
import {
  TtsService,
  ttsService,
  type ResolvedSpeech,
} from '../src/modules/tts';
import { voicePersistence } from './helpers/memory-storage';
import { AgentSpeech } from '../src/modules/world/services/agent-speech.service';
import { WorldRoom } from '../src/modules/world/world.room';

vi.mock('../src/modules/tts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/tts')>();
  return {
    ...actual,
    ttsService: {
      list: vi.fn(),
      get: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
      resolveSpeech: vi.fn(),
      synthesizer: vi.fn(),
      synthesize: vi.fn(),
      models: vi.fn(),
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

const wav = () => {
  const b = Buffer.alloc(32044);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(32000, 40);
  for (let i = 44; i < b.length; i += 2) b.writeInt16LE(1000, i);
  return b;
};

it('cancels old synthesis and private clips when a service binding changes via domainEvents', async () => {
  let finish!: (value: { bytes: Buffer; durationMs: number }) => void;
  let signal!: AbortSignal;
  const actorVoices = new Map<string, string>([['ai', 'local-default']]);
  vi.mocked(ttsService.synthesizer).mockImplementation(
    async (): Promise<ResolvedSpeech> => ({
      kind: 'server',
      synthesizer: {
        synthesize: async (_text: string, abort: AbortSignal) => {
          signal = abort;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    }),
  );

  const players: Player[] = [
    {
      id: 'ai',
      kind: 'ai-agent',
      name: 'AI',
      connected: true,
      voiceReplies: true,
      x: 0,
      y: 2,
      z: 0,
      yaw: 0,
    },
    {
      id: 'human',
      kind: 'human',
      name: 'Human',
      connected: true,
      voiceListening: true,
      x: 0,
      y: 2,
      z: -2,
      yaw: 0,
    },
  ];
  const notify = vi.fn();
  const speech = new AgentSpeech(
    () => players,
    notify,
    vi.fn(),
    (actor) => ttsService.synthesizer(actorVoices.get(actor)!),
  );
  const unsubscribe = domainEvents.on(
    'agent.voice.bound',
    ({ sessionId, serviceId }) => {
      if (actorVoices.get(sessionId) === serviceId) return;
      speech.cancel(sessionId);
      actorVoices.set(sessionId, serviceId);
    },
  );
  try {
    speech.enqueue('ai', {
      kind: 'text',
      scope: 'private',
      recipients: ['human'],
      text: 'Hello',
      name: 'AI',
    });
    await vi.waitFor(() => expect(signal).toBeDefined());
    domainEvents.emit('agent.voice.bound', {
      sessionId: 'ai',
      serviceId: 'second-voice',
    });
    expect(signal.aborted).toBe(true);
    finish({ bytes: wav(), durationMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
    speech.close();
  }
});

it('does not bind a session that closes while its configuration is being read', async () => {
  const coordinator = new CharacterVoiceCoordinator();
  let release!: () => void;
  vi.mocked(ttsService.get).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      id: 'local-default',
      name: 'Local',
      type: 'speaches',
      baseUrl: '',
      apiKey: '',
      model: 'piper',
      voice: 'default',
      speed: 1,
    };
  });

  const bound: Array<{ sessionId: string; serviceId: string }> = [];
  const off = domainEvents.on('agent.voice.bound', (payload) =>
    bound.push(payload),
  );
  try {
    const job = {
      view: {
        sessionId: 'agent-session' as string | undefined,
        voiceReplies: true,
        voiceServiceId: 'local-default',
        permissions: { move: true, chat: true, place: false, remove: false },
      },
    } as unknown as Job;

    const pending = coordinator.bindVoice(job);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    delete job.view.sessionId;
    coordinator.unbindVoice('agent-session');
    release();
    await pending;
    expect(bound).toEqual([]);
  } finally {
    off();
  }
});

it('delegates unmanaged, saved and empty bindings to the TTS resolver', async () => {
  const room = Object.create(WorldRoom.prototype) as {
    actorVoices: Map<string, string>;
    resolveActorSpeech(actor: string): Promise<ResolvedSpeech>;
  };
  const defaultVoice: ResolvedSpeech = {
    kind: 'server',
    synthesizer: { synthesize: vi.fn() },
  };
  const savedVoice: ResolvedSpeech = {
    kind: 'browser',
    voice: { voice: 'voice', speed: 1 },
  };
  const emptyVoice: ResolvedSpeech = {
    kind: 'server',
    synthesizer: { synthesize: vi.fn() },
  };
  vi.mocked(ttsService.resolveSpeech)
    .mockResolvedValueOnce(defaultVoice)
    .mockResolvedValueOnce(savedVoice)
    .mockResolvedValueOnce(emptyVoice);
  room.actorVoices = new Map([
    ['managed', 'service-id'],
    ['disabled', ''],
  ]);

  expect(await room.resolveActorSpeech('unmanaged')).toBe(defaultVoice);
  expect(await room.resolveActorSpeech('managed')).toBe(savedVoice);
  expect(await room.resolveActorSpeech('disabled')).toBe(emptyVoice);
  expect(vi.mocked(ttsService.resolveSpeech).mock.calls).toEqual([
    [undefined],
    ['service-id'],
    [''],
  ]);
});

it.each([undefined, '', 'old'])(
  'rejects speech resolved after binding %s changes',
  async (oldBinding) => {
    const room = Object.create(WorldRoom.prototype) as {
      actorVoices: Map<string, string>;
      resolveActorSpeech(actor: string): Promise<ResolvedSpeech>;
    };
    room.actorVoices = new Map();
    if (oldBinding !== undefined) room.actorVoices.set('managed', oldBinding);
    let finish!: (voice: ResolvedSpeech) => void;
    vi.mocked(ttsService.resolveSpeech).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const resolving = room.resolveActorSpeech('managed');
    room.actorVoices.set('managed', 'new');
    finish({ kind: 'server', synthesizer: { synthesize: vi.fn() } });
    await expect(resolving).rejects.toMatchObject({ status: 409 });
  },
);

it('prevents deleting a voice while a runtime binding is being established', async () => {
  const store = new TtsService(voicePersistence());
  let release!: () => void;
  vi.mocked(ttsService.get).mockImplementationOnce(async (id) => {
    const value = await store.get(id);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return value;
  });
  const job = {
    view: {
      sessionId: 'session',
      voiceReplies: true,
      voiceServiceId: 'local-default',
      permissions: { chat: true },
    },
  } as unknown as Job;
  const bound = vi.fn();
  const off = domainEvents.on('agent.voice.bound', bound);
  const binding = new CharacterVoiceCoordinator().bindVoice(job);
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(store.remove('local-default')).rejects.toMatchObject({
      status: 409,
    });
  } finally {
    release?.();
  }
  try {
    await binding;
    expect(bound).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session',
      serviceId: 'local-default',
    });
  } finally {
    off();
  }
});

it('rejects a new binding while the voice deletion transaction is in progress', async () => {
  const persistence = voicePersistence();
  const transaction = persistence.transaction.bind(persistence);
  let release!: () => void;
  vi.spyOn(persistence, 'transaction').mockImplementation((run) =>
    transaction((tx) =>
      run({
        ...tx,
        remove: async (id) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          await tx.remove(id);
        },
      }),
    ),
  );
  const store = new TtsService(persistence);
  const removing = store.remove('local-default');
  const job = {
    view: {
      sessionId: 'session',
      voiceReplies: true,
      voiceServiceId: 'local-default',
      permissions: { chat: true },
    },
  } as unknown as Job;
  const bound = vi.fn();
  const off = domainEvents.on('agent.voice.bound', bound);
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(
      new CharacterVoiceCoordinator().bindVoice(job),
    ).rejects.toMatchObject({ status: 409 });
    expect(ttsService.get).not.toHaveBeenCalled();
    expect(bound).not.toHaveBeenCalled();
  } finally {
    release?.();
    off();
  }
  await removing;
  await expect(store.get('local-default')).rejects.toMatchObject({
    status: 404,
  });
});
