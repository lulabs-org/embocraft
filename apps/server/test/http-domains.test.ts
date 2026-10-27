import { rename } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { createTestServer } from './helpers/test-server';
import { LocalSpeech } from '../src/modules/audio/asr/local-speech';
import { PiperModels } from '../src/modules/audio/tts/piper-models';

const token = 'Bearer fixture-gateway-token-for-tests';
const origin = 'http://world.test';
const headers = {
  Authorization: token,
  Origin: origin,
  'Content-Type': 'application/json',
};

it('assembles public audio endpoints separately from protected management routes', async () => {
  const speech = new LocalSpeech();
  vi.spyOn(speech, 'status').mockResolvedValue({
    available: true,
    reason: 'fixture',
  });
  const transcribe = vi
    .spyOn(speech, 'transcribe')
    .mockResolvedValue('fixture text');
  vi.spyOn(PiperModels.prototype, 'status').mockResolvedValue({
    available: false,
    reason: 'fixture',
  });
  const server = await createTestServer({ origin, speech });
  try {
    const capabilities = await fetch(server.httpUrl + '/voice/capabilities', {
      headers: { Origin: origin },
    });
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toMatchObject({
      local: { available: true },
    });
    const response = await fetch(
      server.httpUrl + '/voice/transcribe?language=en',
      {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'audio/wav' },
        body: 'fixture audio',
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'fixture text' });
    expect(transcribe.mock.calls[0][0]).toEqual(Buffer.from('fixture audio'));
    expect(transcribe.mock.calls[0][2]).toBe('en');
    const missing = await fetch(server.httpUrl + '/voice/tts/missing', {
      headers,
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: '管理接口不存在，请确认前后端版本一致。',
    });
    const spec = await (await fetch(server.httpUrl + '/api-docs.json')).json();
    for (const [path, method] of [
      ['/health', 'get'],
      ['/voice/capabilities', 'get'],
      ['/voice/transcribe', 'post'],
      ['/voice/asr/services', 'get'],
      ['/voice/tts/services', 'get'],
      ['/voice/tts/piper/models', 'get'],
    ]) {
      expect(spec.paths[path]?.[method], `${method} ${path}`).toBeDefined();
    }
  } finally {
    await server.close();
    vi.restoreAllMocks();
  }
});

it('protects each management domain and retains transport policies after path migration', async () => {
  const server = await createTestServer({ origin });
  try {
    const paths = [
      '/ai-characters',
      '/providers',
      '/providers/missing/health',
      '/tasks',
      '/task-runs/missing/pause',
      '/management/commands/missing',
      '/voice/tts/services',
      '/voice/tts/piper/models',
      '/voice/asr/services',
    ];
    for (const path of paths) {
      const url = server.httpUrl + path;
      expect((await fetch(url)).status, path).toBe(401);
      expect(
        (
          await fetch(url, {
            headers: { ...headers, Origin: 'https://foreign.test' },
          })
        ).status,
        path,
      ).toBe(403);
      const preflight = await fetch(url, {
        method: 'OPTIONS',
        headers: { Origin: origin },
      });
      expect(preflight.status, path).toBe(204);
      expect(preflight.headers.get('access-control-allow-methods')).toContain(
        'PUT',
      );
      expect(preflight.headers.get('access-control-allow-methods')).toContain(
        'DELETE',
      );
      expect(preflight.headers.get('access-control-allow-headers')).toContain(
        'Authorization',
      );
      const badType = await fetch(url, {
        method: 'POST',
        headers: { Authorization: token, Origin: origin },
        body: 'x',
      });
      expect(badType.status, path).toBe(415);
      const badJson = await fetch(url, { method: 'POST', headers, body: '{' });
      expect(badJson.status, path).toBe(400);
      expect((await badJson.json()).error).toContain(
        path.startsWith('/voice/asr') ? 'JSON' : '无法处理请求',
      );
      const large = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'x'.repeat(40000) }),
      });
      expect(large.status, path).toBe(413);
      if (!path.startsWith('/voice/asr')) {
        const invalidKey = await fetch(url, {
          headers: { ...headers, 'Idempotency-Key': 'invalid key' },
        });
        expect(invalidKey.status, path).toBe(400);
      }
      const unauthenticatedJson = await fetch(url, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: '{',
      });
      expect(unauthenticatedJson.status, path).toBe(401);
      const deniedPreflight = await fetch(url, {
        method: 'OPTIONS',
        headers: { Origin: 'https://foreign.test' },
      });
      expect(deniedPreflight.status, path).toBe(403);
      expect(
        deniedPreflight.headers.get('access-control-allow-origin'),
      ).toBeNull();
    }
    for (const path of [
      '/ai-characters',
      '/providers',
      '/voice/tts/services',
      '/voice/asr/services',
    ]) {
      const response = await fetch(server.httpUrl + path, { headers });
      expect(response.status, path).toBe(200);
      expect(Array.isArray(await response.json())).toBe(true);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    const plans = await fetch(
      server.httpUrl + '/tasks?state=unassigned&offset=0',
      { headers },
    );
    expect(plans.status).toBe(200);
    expect(await plans.json()).toMatchObject({ items: [], total: 0 });
    const asrLarge = await fetch(server.httpUrl + '/voice/asr/services', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'x'.repeat(9000) }),
    });
    expect(asrLarge.status).toBe(413);
    const voiceLarge = await fetch(server.httpUrl + '/voice/tts/services', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'x'.repeat(9000) }),
    });
    expect(voiceLarge.status).toBe(400); // Parsed under 32 KiB, rejected by service validation.
  } finally {
    await server.close();
  }
});

it('routes resource IDs and request bodies to their owning domain without old Agent aliases', async () => {
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      if (typeof input === 'string' && input.includes('11434')) {
        return Response.json({ data: [{ id: 'fixture-model' }] });
      }
      return originalFetch(input, init);
    });
  const server = await createTestServer({ origin });
  try {
    const createProvider = await fetch(server.httpUrl + '/providers', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'ollama',
        name: 'Local',
        baseUrl: 'http://127.0.0.1:11434/v1',
      }),
    });
    expect(createProvider.status).toBe(201);
    const provider = await createProvider.json();
    expect(
      await (
        await fetch(`${server.httpUrl}/providers/${provider.id}/models`, {
          headers,
        })
      ).json(),
    ).toEqual({ models: ['fixture-model'] });
    expect(
      await (
        await fetch(`${server.httpUrl}/providers/${provider.id}/health`, {
          headers,
        })
      ).json(),
    ).toEqual({ reachable: true, modelsAvailable: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer ollama' },
        redirect: 'error',
      }),
    );
    expect(
      (
        await fetch(`${server.httpUrl}/providers/${provider.id}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            type: 'ollama',
            name: 'Updated',
            baseUrl: 'http://127.0.0.1:11434/v1',
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${server.httpUrl}/providers/${provider.id}`, {
          method: 'DELETE',
          headers,
        })
      ).status,
    ).toBe(204);
    expect('assignTask' in server.characters).toBe(false);
    expect('controlTask' in server.characters).toBe(false);
    expect('resume' in server.characters).toBe(false);
    for (const operation of ['task', 'pause', 'resume', 'cancel']) {
      const removed = await fetch(
        `${server.httpUrl}/ai-characters/agent-123/${operation}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ goal: 'test' }),
        },
      );
      expect(removed.status).toBe(404);
    }
    const createPlan = vi
      .spyOn(server.characters.tasks, 'createTaskPlan')
      .mockResolvedValue({ id: 'plan-123' } as Awaited<
        ReturnType<typeof server.characters.tasks.createTaskPlan>
      >);
    const draft = {
      characterId: 'agent-123',
      name: 'Plan',
      goal: 'test',
      timing: { kind: 'immediate' },
      timeZone: 'UTC',
    };
    expect(
      (
        await fetch(server.httpUrl + '/tasks', {
          method: 'POST',
          headers,
          body: JSON.stringify(draft),
        })
      ).status,
    ).toBe(201);
    expect(createPlan).toHaveBeenCalledWith('agent-123', {
      ...draft,
      requestId: expect.any(String),
    });
    const run = vi
      .spyOn(server.characters.tasks, 'controlTaskRun')
      .mockResolvedValue({ id: 'run-123' } as Awaited<
        ReturnType<typeof server.characters.tasks.controlTaskRun>
      >);
    for (const operation of ['pause', 'resume', 'cancel']) {
      expect(
        (
          await fetch(`${server.httpUrl}/task-runs/run-123/${operation}`, {
            method: 'POST',
            headers,
            body: '{}',
          })
        ).status,
      ).toBe(200);
      expect(run).toHaveBeenCalledWith(undefined, 'run-123', operation, {});
    }
    const reassign = vi
      .spyOn(server.characters.tasks, 'reassignPlan')
      .mockResolvedValue({ id: 'plan-123' } as Awaited<
        ReturnType<typeof server.characters.tasks.createTaskPlan>
      >);
    expect(
      (
        await fetch(server.httpUrl + '/tasks/plan-123/reassign', {
          method: 'POST',
          headers,
          body: JSON.stringify({ targetCharacterId: 'agent-456' }),
        })
      ).status,
    ).toBe(200);
    expect(reassign).toHaveBeenCalledWith('plan-123', 'agent-456', {
      targetCharacterId: 'agent-456',
    });
    const voice = await fetch(server.httpUrl + '/voice/tts/services', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'browser',
        name: 'Browser',
        voice: 'Test',
        speed: 1,
      }),
    });
    expect(voice.status).toBe(201);
    const service = await voice.json();
    expect(
      (
        await fetch(`${server.httpUrl}/voice/tts/services/${service.id}`, {
          method: 'DELETE',
          headers,
        })
      ).status,
    ).toBe(204);
    for (const path of [
      '/agents',
      '/agents/missing',
      '/ai-characters/providers',
      '/ai-characters/tasks',
      '/ai-characters/task-runs/missing/pause',
      '/ai-characters/voice-services',
      '/ai-characters/voice-services/piper/models',
    ]) {
      expect(
        (await fetch(server.httpUrl + path, { headers })).status,
        path,
      ).toBe(404);
    }
  } finally {
    vi.restoreAllMocks();
    await server.close();
  }
});

it('keeps a stopped character provider until the character is removed', async () => {
  const server = await createTestServer({ origin });
  const changed = vi.fn();
  const off = server.characters.events.on(changed);
  const providerUrl = server.httpUrl + '/providers/deepseek';
  try {
    const created = await fetch(server.httpUrl + '/ai-characters', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        providerId: 'deepseek',
        name: 'Stopped fixture',
        joinWorld: false,
      }),
    });
    expect(created.status).toBe(201);
    const character = await created.json();
    expect(server.characters.hasProviderReference('deepseek')).toBe(true);

    const blocked = await fetch(providerUrl, { method: 'DELETE', headers });
    expect(blocked.status).toBe(409);
    expect(
      changed.mock.calls.filter(([event]) => event.resource === 'providers'),
    ).toHaveLength(0);

    expect(
      (
        await fetch(`${server.httpUrl}/ai-characters/${character.id}`, {
          method: 'DELETE',
          headers,
        })
      ).status,
    ).toBe(204);
    expect(server.characters.hasProviderReference('deepseek')).toBe(false);

    const deleteHeaders = { ...headers, 'Idempotency-Key': 'delete-deepseek' };
    expect(
      (await fetch(providerUrl, { method: 'DELETE', headers: deleteHeaders }))
        .status,
    ).toBe(204);
    expect(
      (await fetch(providerUrl, { method: 'DELETE', headers: deleteHeaders }))
        .status,
    ).toBe(204);
    expect(
      changed.mock.calls.filter(([event]) => event.resource === 'providers'),
    ).toHaveLength(1);
    expect(
      (await fetch(providerUrl, { method: 'DELETE', headers })).status,
    ).toBe(404);
  } finally {
    off();
    await server.close();
  }
});

it('returns one persisted result for concurrent HTTP commands and protects receipt lookup', async () => {
  const server = await createTestServer({ origin });
  const body = {
    providerId: 'deepseek',
    name: 'Receipt fixture',
    joinWorld: false,
  };
  const send = (value = body) =>
    fetch(server.httpUrl + '/ai-characters', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'same-create' },
      body: JSON.stringify(value),
    });
  try {
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const first = await a.json();
    expect((await b.json()).id).toBe(first.id);
    expect(server.characters.publicList()).toHaveLength(1);
    expect((await send({ ...body, name: 'Different' })).status).toBe(409);
    const receiptUrl = server.httpUrl + '/management/commands/same-create';
    expect((await fetch(receiptUrl)).status).toBe(401);
    const receipt = await (await fetch(receiptUrl, { headers })).json();
    expect(receipt).toMatchObject({
      state: 'committed',
      result: { id: first.id },
    });
    expect(JSON.stringify(receipt)).not.toContain('fixture-only');
    expect(
      await (
        await fetch(server.httpUrl + '/management/commands/missing', {
          headers,
        })
      ).json(),
    ).toEqual({ state: 'unknown' });
  } finally {
    await server.close();
  }
});

it('does not acknowledge or publish an HTTP creation whose archive cannot be saved', async () => {
  const session = vi.fn();
  const server = await createTestServer({
    origin,
    agentDependencies: {
      session,
      runner: () => ({ run: async () => {} }),
    },
  });
  const changed = vi.fn();
  const off = server.characters.events.on(changed);
  const moved = server.directory + '-unavailable';
  await rename(server.directory, moved);
  try {
    const response = await fetch(server.httpUrl + '/ai-characters', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'failed-create' },
      body: JSON.stringify({ providerId: 'deepseek', name: 'Failure fixture' }),
    });
    expect(response.status).toBe(500);
    expect(session).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(server.characters.publicList()).toEqual([]);
    const receipt = await (
      await fetch(server.httpUrl + '/management/commands/failed-create', {
        headers,
      })
    ).json();
    expect(receipt.state).toBe('rejected');
    expect(JSON.stringify(receipt)).not.toContain(server.directory);
  } finally {
    off();
    await rename(moved, server.directory);
    await server.close();
  }
});

it('shares command receipts across management domains without adding receipts to TTS or ASR', async () => {
  const server = await createTestServer({ origin });
  const id = 'cross-domain-command';
  const commandHeaders = { ...headers, 'Idempotency-Key': id };
  const providerBody = JSON.stringify({
    type: 'ollama',
    name: 'Receipt provider',
    baseUrl: 'http://127.0.0.1:11434/v1',
  });
  try {
    const sendProvider = () =>
      fetch(server.httpUrl + '/providers', {
        method: 'POST',
        headers: commandHeaders,
        body: providerBody,
      });
    const first = await sendProvider();
    expect(first.status).toBe(201);
    const provider = await first.json();
    const retry = await sendProvider();
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(provider);
    // Same method/body at a different domain must not replay the provider result.
    for (const path of [
      '/ai-characters',
      '/tasks',
      '/task-runs/run-123/pause',
    ]) {
      const conflict = await fetch(server.httpUrl + path, {
        method: 'POST',
        headers: commandHeaders,
        body: providerBody,
      });
      expect(conflict.status, path).toBe(409);
    }
    const receipt = await fetch(server.httpUrl + '/management/commands/' + id, {
      headers,
    });
    expect(await receipt.json()).toMatchObject({
      state: 'committed',
      result: { id: provider.id },
    });

    const voiceIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const voice = await fetch(server.httpUrl + '/voice/tts/services', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': 'tts-command' },
        body: JSON.stringify({
          type: 'browser',
          name: 'Browser',
          voice: 'Test',
          speed: 1,
        }),
      });
      expect(voice.status).toBe(201);
      voiceIds.push((await voice.json()).id);
    }
    expect(new Set(voiceIds).size).toBe(2);
    const voiceReceipt = await fetch(
      server.httpUrl + '/management/commands/tts-command',
      { headers },
    );
    expect(await voiceReceipt.json()).toEqual({ state: 'unknown' });
    // ASR has no management idempotency-key validation, including for reads.
    const asr = await fetch(server.httpUrl + '/voice/asr/services', {
      headers: { ...headers, 'Idempotency-Key': 'invalid key' },
    });
    expect(asr.status).toBe(200);
  } finally {
    await server.close();
  }
});
