import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { aiCharactersApi } from './ai-characters/api';
import { providersApi } from './providers/api';
import { tasksApi } from './tasks';
import { voiceApi } from './voice/api';
import { initialAICharacter } from './ai-characters/model';
import { freshProvider } from './providers/model';

vi.mock('../../network/gateway', () => ({
  getGatewayToken: () => 'fixture-token',
  adminHeaders: () => ({ Authorization: 'Bearer fixture-token' }),
}));

const http = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv('VITE_SERVER_URL', 'https://world.example');
  vi.stubGlobal('fetch', http);
  http.mockImplementation(() => Promise.resolve(new Response('[]')));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  http.mockReset();
});

it('routes provider queries and mutations through HTTP REST endpoints', async () => {
  const signal = new AbortController().signal;
  http.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify([]))),
  );

  await providersApi.listProviders(signal);
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/providers',
    expect.objectContaining({
      method: 'GET',
      signal: expect.any(AbortSignal),
      headers: expect.objectContaining({
        Authorization: 'Bearer fixture-token',
      }),
    }),
  );

  await providersApi.listModels('custom/provider', signal);
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/providers/custom%2Fprovider/models',
    expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
  );

  const value = freshProvider('compatible');
  await providersApi.saveProvider(value);
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/providers',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(value),
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
      }),
    }),
  );

  await providersApi.saveProvider(value, 'custom');
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/providers/custom',
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(value),
    }),
  );

  http.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await providersApi.deleteProvider('custom');
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/providers/custom',
    expect.objectContaining({ method: 'DELETE' }),
  );
});

it('routes agent operations through HTTP REST endpoints', async () => {
  const signal = new AbortController().signal;
  http.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify([]))),
  );

  await aiCharactersApi.listAgents(signal);
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/ai-characters',
    expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
  );

  const profile = initialAICharacter;
  const value = { ...profile, name: 'Partner' };
  await aiCharactersApi.saveAgent(value);
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/ai-characters',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(value),
    }),
  );

  await aiCharactersApi.saveAgent(value, 'a');
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/ai-characters/a',
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(value),
    }),
  );

  await aiCharactersApi.joinAgent('a');
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/ai-characters/a/join',
    expect.objectContaining({ method: 'POST', body: '{}' }),
  );

  await aiCharactersApi.stopAgent('a');
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/ai-characters/a/stop',
    expect.objectContaining({ method: 'POST', body: '{}' }),
  );

  http.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await aiCharactersApi.deleteAgent('a');
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/ai-characters/a',
    expect.objectContaining({ method: 'DELETE' }),
  );

  await aiCharactersApi.setVoiceReplies('a', false);
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/ai-characters/a/voice',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ enabled: false }),
    }),
  );
});

it('routes task plan queries and controls through HTTP REST endpoints', async () => {
  const identity = { id: 'task', revision: 2, startedAt: 42 };
  http.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ items: [], total: 0 }))),
  );

  await tasksApi.list({ state: 'unassigned', offset: 20 });
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/tasks?state=unassigned&offset=20',
    expect.objectContaining({ method: 'GET' }),
  );

  await tasksApi.get('plan-123');
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/tasks/plan-123',
    expect.objectContaining({ method: 'GET' }),
  );

  await tasksApi.runs('p', 20);
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/tasks/p/runs?offset=20',
    expect.objectContaining({ method: 'GET' }),
  );

  await tasksApi.control(
    { id: 'p', characterId: 'agent-1', revision: 3 } as Parameters<
      typeof tasksApi.control
    >[0],
    'run',
    { requestId: 'stable' },
    identity,
  );
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/tasks/p/run',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        requestId: 'stable',
        characterId: 'agent-1',
        expectedPlanRevision: 3,
        expectedTask: identity,
      }),
    }),
  );

  await tasksApi.reassign(
    { id: 'p', characterId: 'agent-1', revision: 3 } as Parameters<
      typeof tasksApi.control
    >[0],
    'agent-2',
  );
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/tasks/p/reassign',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ targetCharacterId: 'agent-2' }),
    }),
  );

  http.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await tasksApi.delete('p', 'agent-1');
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/tasks/p',
    expect.objectContaining({ method: 'DELETE' }),
  );

  await tasksApi.controlRun('run-99', 'resume', {}, identity);
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/task-runs/run-99/resume',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ expectedTask: identity }),
    }),
  );
});

it('retains authenticated HTTP voice management and actionable HTTP errors', async () => {
  const signal = new AbortController().signal;
  http.mockResolvedValueOnce(new Response('[]'));
  await voiceApi.listVoiceServices(signal);
  expect(http).toHaveBeenCalledWith(
    'https://world.example/voice/tts/services',
    expect.objectContaining({
      signal: expect.any(AbortSignal),
      headers: expect.objectContaining({
        Authorization: 'Bearer fixture-token',
      }),
    }),
  );

  http.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: '音色不可用' }), { status: 503 }),
  );
  await expect(voiceApi.listVoiceServices(signal)).rejects.toThrow('音色不可用');
});

it('uses the TTS domain for service CRUD and binary preview', async () => {
  const signal = new AbortController().signal;
  await voiceApi.listVoiceServices(signal);
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/voice/tts/services',
    expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
  );
  const draft = {
    type: 'browser' as const,
    baseUrl: '',
    model: '',
    apiKey: '',
    name: 'Browser',
    voice: 'Test',
    speed: 1,
  };
  await voiceApi.saveVoiceService(draft);
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/voice/tts/services',
    expect.objectContaining({ method: 'POST', body: JSON.stringify(draft) }),
  );
  await voiceApi.saveVoiceService(draft, 'custom/voice');
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/voice/tts/services/custom%2Fvoice',
    expect.objectContaining({ method: 'PUT' }),
  );
  http.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await voiceApi.deleteVoiceService('custom/voice');
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/voice/tts/services/custom%2Fvoice',
    expect.objectContaining({ method: 'DELETE' }),
  );
  http.mockResolvedValueOnce(
    new Response('wav', { headers: { 'Content-Type': 'audio/wav' } }),
  );
  expect(
    await (await voiceApi.previewVoice('custom/voice', 'hello', signal)).text(),
  ).toBe('wav');
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/voice/tts/services/custom%2Fvoice/preview',
    expect.objectContaining({
      method: 'POST',
      signal: expect.any(AbortSignal),
      headers: expect.objectContaining({
        Authorization: 'Bearer fixture-token',
      }),
      body: '{"text":"hello"}',
    }),
  );
});

it('saves a selected replacement role with the existing binding in one request', async () => {
  const previous = { id: 'p', characterId: 'agent-1' } as Parameters<
    typeof tasksApi.save
  >[2];
  const draft = { name: 'Updated plan' } as Parameters<typeof tasksApi.save>[1];
  await tasksApi.save('agent-2', draft, previous, 'save-1');
  expect(http).toHaveBeenLastCalledWith(
    'https://world.example/tasks/p',
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        name: 'Updated plan',
        requestId: 'save-1',
        characterId: 'agent-1',
        targetCharacterId: 'agent-2',
      }),
    }),
  );
});
