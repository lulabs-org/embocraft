import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mkdtemp, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { VoiceServiceStore } from '../src/modules/audio/tts/voice-services';

import { AgentSpeech } from '../src/modules/audio/services/tts/agent-speech.service';

import { DEFAULT_PIPER_MODEL, PIPER_MODELS, type Player } from '@voxel/shared';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'voice-services-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const local = (name = 'Local', voice = '') => ({
  name,
  type: 'piper',
  model: voice === 'Samantha' ? PIPER_MODELS[1].id : DEFAULT_PIPER_MODEL,
  voice: '',
  speed: 1,
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

it('cancels old synthesis and private clips when a service binding changes', async () => {
  let finish!: (value: { bytes: Buffer; durationMs: number }) => void;
  let signal!: AbortSignal;
  const store = new VoiceServiceStore(join(dir, 'voices.json'), () => ({
    synthesize: async (_text, abort) => {
      signal = abort;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  }));
  await store.load();
  const second = await store.save(local('second'));
  store.bind('ai', 'local-default');
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
    (actor) => store.forActor(actor),
  );
  const unsubscribe = store.onChange((actor) => speech.cancel(actor));
  speech.enqueue('ai', {
    kind: 'text',
    scope: 'private',
    recipients: ['human'],
    text: 'Hello',
    name: 'AI',
  });
  store.bind('ai', second.id);
  expect(signal.aborted).toBe(true);
  finish({ bytes: wav(), durationMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(notify).not.toHaveBeenCalled();
  unsubscribe();
  speech.close();
});
