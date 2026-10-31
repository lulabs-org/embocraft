import { delay, Session, until } from '@voxel/agent-runtime';

import type {
  AgentSpeechEvent,
  AICharacterView,
  VoiceServiceView,
} from '@voxel/shared';
import express from 'express';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolResponse } from '../../../../tests/support/pi-response';
import { AICharacterManager } from '../../src/modules/ai-characters';
import {
  bootstrapProviders,
  MemoryProviderRepository,
  TestVoiceServiceStore as VoiceServiceStore,
} from '../helpers/memory-storage';
import { createTestServer } from '../helpers/test-server';

import { validatePcmWav } from '../../src/core/audio/pcm-wav';

process.env.DATABASE_URL = '';
process.env.WEB_ORIGIN = 'http://127.0.0.1:5191';
const dir = await mkdtemp(join(tmpdir(), 'voxel-voice-integration-'));
const pcm = Buffer.alloc(32044);
pcm.write('RIFF');
pcm.writeUInt32LE(pcm.length - 8, 4);
pcm.write('WAVEfmt ', 8);
pcm.writeUInt32LE(16, 16);
pcm.writeUInt16LE(1, 20);
pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(16000, 24);
pcm.writeUInt32LE(32000, 28);
pcm.writeUInt16LE(2, 32);
pcm.writeUInt16LE(16, 34);
pcm.write('data', 36);
pcm.writeUInt32LE(32000, 40);
for (let i = 44; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
const fixture = express();
fixture.use(express.json());
const requests: { voice: string; speed: number; input: string }[] = [];
fixture.post('/v1/audio/speech', (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer fixture-voice-key');
  assert.equal(req.body.response_format, 'wav');
  requests.push(req.body);
  res.type('audio/wav').send(pcm);
});
const providerHttp = createServer(fixture);
await new Promise<void>((resolve) =>
  providerHttp.listen(0, '127.0.0.1', resolve),
);
const providerUrl = `http://127.0.0.1:${(providerHttp.address() as { port: number }).port}/v1`;
const voices = new VoiceServiceStore();
await voices.load();
const providers = new MemoryProviderRepository();
await bootstrapProviders(providers);
await providers.save(
  {
    name: 'DeepSeek',
    type: 'deepseek',
    apiKey: 'fixture-model-key',
    defaultModel: 'deepseek-flash',
  },
  'deepseek',
);
let server: Awaited<ReturnType<typeof createTestServer>> | undefined;
const humans: Session[] = [],
  bots: Session[] = [];
let manager: AICharacterManager | undefined;
let calls = 0;
try {
  const dependencies = {
    session: (address: string) => {
      const session = new Session(address);
      bots.push(session);
      return session;
    },
    model: () => ({
      endpoint: undefined,
      request: async () => {
        calls++;
        return toolResponse([
          {
            name: 'chat',
            arguments: { text: 'Hello from my selected voice.' },
          },
          {
            name: 'complete_task',
            arguments: {
              summary: 'Done',
            },
          },
        ]);
      },
    }),
  };
  server = await createTestServer({
    directory: dir,
    providers,
    voiceServices: voices,
    origin: process.env.WEB_ORIGIN,
    agentDependencies: dependencies,
  });
  const url = server.httpUrl;
  manager = server.characters;
  const api = (path: string, method = 'GET', body?: unknown) =>
    fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: 'Bearer fixture-gateway-token-for-tests',
        Origin: process.env.WEB_ORIGIN!,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal((await fetch(`${url}/voice/tts/services`)).status, 401);
  const add = async (name: string, voice: string, speed: number) => {
    const response = await api('/voice/tts/services', 'POST', {
      name,
      type: 'compatible',
      baseUrl: providerUrl,
      apiKey: 'fixture-voice-key',
      model: 'fixture-tts',
      voice,
      speed,
    });
    assert.equal(response.status, 201);
    const result = (await response.json()) as VoiceServiceView;
    assert(!JSON.stringify(result).includes('fixture-voice-key'));
    return result;
  };
  const a = await add('Guide', 'alpha', 0.8),
    b = await add('Builder', 'beta', 1.2);
  const preview = await api(`/voice/tts/services/${a.id}/preview`, 'POST', {
    text: 'Preview voice',
  });
  assert.equal(preview.status, 200);
  assert.equal(validatePcmWav(Buffer.from(await preview.arrayBuffer())), 1000);
  assert.equal(requests.at(-1)?.voice, 'alpha');
  for (const name of ['Listener', 'Other']) {
    const s = new Session(url.replace('http', 'ws'));
    humans.push(s);
    await s.join(name, 'human');
    await s.request('spatial.state', { sending: false, listening: true });
  }
  const events: AgentSpeechEvent[][] = [[], []];
  humans.forEach((s, i) =>
    s.room.onMessage('agent.speech', (e: AgentSpeechEvent) =>
      events[i].push(e),
    ),
  );
  await until(() => humans.every((s) => !!s.chatToken));
  const create = async (serviceId: string, name: string) => {
    const response = await api('/ai-characters', 'POST', {
      providerId: 'deepseek',
      name,
      maxTurns: 1,
      voiceReplies: true,
      voiceServiceId: serviceId,
    });
    assert.equal(response.status, 201);
    const job = (await response.json()) as AICharacterView;
    await until(
      () => manager!.list().find((j) => j.id === job.id)?.status === 'idle',
    );
    assert.equal(
      (
        await api('/tasks', 'POST', {
          characterId: job.id,
          name: 'Say hello once',
          goal: 'Say hello once.',
          timing: { kind: 'immediate' },
          timeZone: 'UTC',
          limits: { maxTurns: 1 },
        })
      ).status,
      201,
    );
    await until(
      () =>
        manager!.list().find((j) => j.id === job.id)?.task?.status ===
        'completed',
    );
    return manager!.list().find((j) => j.id === job.id)!;
  };
  const first = await create(a.id, 'Guide'),
    second = await create(b.id, 'Builder');
  await until(() => events[0].length === 2 && events[1].length === 2);
  assert.deepEqual(
    requests.slice(1).map((r) => [r.voice, r.speed]),
    [
      ['alpha', 0.8],
      ['beta', 1.2],
    ],
  );
  assert.equal(first.voiceServiceId, a.id);
  assert.equal(second.voiceServiceName, 'Builder');
  assert.equal(
    (await api(`/voice/tts/services/${a.id}`, 'DELETE')).status,
    409,
  );
  // Editing an idle Agent changes its actual next utterance without restarting the task.
  assert.equal(
    (await api(`/ai-characters/${first.id}`, 'PUT', { voiceServiceId: b.id }))
      .status,
    200,
  );
  const before = events[1].length;
  await delay(350);
  assert(
    (
      await bots[0].request('chat', {
        text: 'Private voice test.',
        scope: 'private',
        recipients: [humans[0].room.sessionId],
      })
    ).ok,
  );
  await until(() => events[0].length === 3);
  assert.equal(events[1].length, before);
  assert.equal(requests.at(-1)?.voice, 'beta');
  const privateClip = events[0].at(-1)!;
  const audio = (listener: Session) =>
    fetch(`${url}/chat/agent-speech/${privateClip.id}`, {
      headers: {
        Origin: process.env.WEB_ORIGIN!,
        Authorization: `Bearer ${listener.chatToken}`,
      },
    });
  assert.equal((await audio(humans[1])).status, 404);
  assert.equal(
    validatePcmWav(Buffer.from(await (await audio(humans[0])).arrayBuffer())),
    1000,
  );
  assert.equal(
    (await api(`/voice/tts/services/${a.id}`, 'DELETE')).status,
    204,
  );
  if (process.env.REAL_TTS === '1') {
    if (process.env.REAL_TTS_MODEL) {
      const saved = await api('/voice/tts/services/local-default', 'PUT', {
        name: 'Piper integration voice',
        type: 'piper',
        model: process.env.REAL_TTS_MODEL,
        speed: 1,
      });
      assert.equal(saved.status, 200);
    }
    const local = await api(
      '/voice/tts/services/local-default/preview',
      'POST',
      {
        text: '你好，这是本地语音试听。',
      },
    );
    assert.equal(local.status, 200);
    assert(validatePcmWav(Buffer.from(await local.arrayBuffer()), 90.5) > 250);
    await create('local-default', 'Local voice');
    await until(() => events[1].length === 3, 30000);
    console.log('Real local TTS: preview and managed Agent audio passed.');
  }
  const count = calls;
  await manager.close();
  const restoredVoices = new VoiceServiceStore(voices.persistence);
  await restoredVoices.load();
  assert.equal(restoredVoices.get(b.id).voice, 'beta');
  await voices.load();
  const restored = new AICharacterManager(
    providers,
    url.replace('http', 'ws'),
    providers.archive,
    dependencies,
    voices,
  );
  await restored.load();
  assert.equal(
    restored.list().find((j) => j.id === first.id)?.voiceServiceId,
    b.id,
  );
  assert.equal(calls, count, 'restoration must not invoke the model');
  const restoredId = restored.list().find((j) => j.id === first.id)!.sessionId;
  const restoredBot = bots.find((s) => s.room.sessionId === restoredId)!;
  const requestsBefore = requests.length;
  assert(
    (
      await restoredBot.request('chat', {
        text: 'Restored voice.',
        scope: 'private',
        recipients: [humans[0].room.sessionId],
      })
    ).ok,
  );
  await until(() => requests.length > requestsBefore);
  assert.equal(requests.at(-1)?.voice, 'beta');
  await restored.close();
  console.log(
    'Voice services: CRUD, privacy, preview, per-Agent routing, live rebinding, deletion guard and persistence passed; no paid model called.',
  );
} finally {
  await manager?.close();
  await Promise.allSettled([...humans, ...bots].map((s) => s.close()));
  await server?.close();
  await new Promise<void>((resolve) => providerHttp.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
}
