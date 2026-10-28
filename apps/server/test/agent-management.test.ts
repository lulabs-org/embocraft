import type { Observation } from '@voxel/agent-runtime';
import { describe, expect, it, vi } from 'vitest';
import { testAgentConfig } from '../../../tests/support/agent-config';
import { DecisionFixture as ModelPlanner } from '../../../tests/support/decision-fixture';
import { validateAICharacter } from '../src/modules/ai-characters';
import {
  bootstrapProviders,
  ModelCatalog,
  validateProvider,
} from '../src/modules/providers';
import { MemoryProviderRepository } from './helpers/memory-storage';

const provider = () =>
  validateProvider({
    name: 'Test',
    type: 'deepseek',
    apiKey: 'fixture-secret',
    defaultModel: 'deepseek-flash',
  });
describe('provider configuration boundary', () => {
  it('saves console credentials privately and never returns them', async () => {
    const store = new MemoryProviderRepository();
    await bootstrapProviders(store);
    await store.save(
      {
        name: 'DeepSeek',
        type: 'deepseek',
        apiKey: 'fixture-secret',
        defaultModel: 'deepseek-flash',
      },
      'deepseek',
    );
    expect(JSON.stringify(store.list())).not.toContain('fixture-secret');
    expect(store.list()[0].hasApiKey).toBe(true);
    const saved = await store.save(
      { ...store.list()[0], name: 'Updated', apiKey: '' },
      'deepseek',
    );
    expect(saved.name).toBe('Updated');
    expect(store.get('deepseek')).toMatchObject({ hasApiKey: true });
    expect(store.get('deepseek')).not.toHaveProperty('apiKey');
    expect(store.getRuntime('deepseek').apiKey).toBe('fixture-secret');
    const reloaded = new MemoryProviderRepository(store.storage);
    await bootstrapProviders(reloaded);
    expect(reloaded.get('deepseek')).not.toHaveProperty('apiKey');
    expect(reloaded.getRuntime('deepseek').apiKey).toBe('fixture-secret');
    await Promise.all([
      store.save({ name: 'A', type: 'ollama' }),
      store.save({ name: 'B', type: 'ollama' }),
    ]);
    expect(await store.storage.load()).toHaveLength(4);
    await store.remove('ollama');
    expect(store.list()).toHaveLength(3);
  });
  it.each([
    'http://remote.example/v1',
    'https://user:password@example.com/v1',
    'https://example.com/v1?key=x',
    'file:///tmp/key',
  ])('rejects unsafe endpoint %s', (baseUrl) => {
    expect(() =>
      validateProvider({ name: 'Test', type: 'compatible', baseUrl }),
    ).toThrow();
  });
  it.each([
    'http://localhost:11434/v1',
    'http://192.168.31.1:11434/v1',
    'http://10.0.0.2:11434/v1',
    'http://8.8.8.8:11434/v1',
    'http://100.101.102.103:11434/v1',
    'http://ollama.example.com:11434/v1',
    'https://public.example/v1',
    'http://[fd12:3456::1]:11434/v1',
  ])('accepts Ollama endpoint %s', (baseUrl) => {
    expect(
      validateProvider({ name: 'LAN', type: 'ollama', baseUrl }).baseUrl,
    ).toBe(baseUrl);
  });
  it.each([
    'file:///tmp/ollama',
    'ftp://ollama.example.com/v1',
    'http://user:password@192.168.31.1:11434/v1',
    'http://192.168.31.1:11434/v1?key=secret',
    'http://192.168.31.1:11434/v1#key',
  ])('rejects malformed Ollama endpoint %s', (baseUrl) => {
    expect(() =>
      validateProvider({ name: 'LAN', type: 'ollama', baseUrl }),
    ).toThrow();
  });
  it('keeps private HTTP limited to Ollama', () => {
    expect(() =>
      validateProvider({
        name: 'Test',
        type: 'compatible',
        baseUrl: 'http://192.168.31.1/v1',
      }),
    ).toThrow();
  });
  it('does not forward saved credentials when changing origin or provider type', () => {
    const previous = provider();
    expect(() =>
      validateProvider(
        {
          ...previous,
          type: 'compatible',
          baseUrl: 'https://other.example/v1',
          apiKey: '',
        },
        previous,
      ),
    ).toThrow('重新填写');
    expect(
      validateProvider(
        {
          ...previous,
          type: 'compatible',
          baseUrl: 'https://other.example/v1',
          apiKey: 'new-secret',
        },
        previous,
      ).apiKey,
    ).toBe('new-secret');
  });
  it('bounds runtime settings and defaults to no block edits', () => {
    const p = provider();
    const input = { name: 'AI', goal: 'Observe' };
    expect(validateAICharacter(input, p)).toMatchObject({
      maxTurns: 100,
      allowEdits: false,
      model: 'deepseek-flash',
    });
    for (const invalid of [
      { maxTurns: 1001 },
      { intervalMs: 0 },
      { allowEdits: 'true' },
      { reasoningEffort: ['high'] },
      { model: 'bad model' },
      { maxTokens: Infinity },
    ])
      expect(() => validateAICharacter({ ...input, ...invalid }, p)).toThrow();
    expect(() => validateAICharacter(input, { ...p, apiKey: '' })).toThrow(
      'API Key',
    );
    const local = validateProvider({
      name: 'Local',
      type: 'ollama',
      defaultModel: 'qwen3:8b',
    });
    expect(validateAICharacter(input, local).model).toBe('qwen3:8b');
    expect(
      validateAICharacter({ ...input, thinking: 'enabled' }, local).thinking,
    ).toBe('enabled');
    expect(() =>
      validateAICharacter({ ...input, thinking: 'invalid' }, local),
    ).toThrow();
  });
  it('accepts optional role guidance without treating it as a task or permission', () => {
    const p = provider();
    const input = { name: '建筑师', goal: '' };
    expect(validateAICharacter(input, p).roleDescription).toBe('');
    expect(
      validateAICharacter(
        { ...input, roleDescription: '  负责规划和建造房屋。\n先确认需求。  ' },
        p,
      ),
    ).toMatchObject({
      roleDescription: '负责规划和建造房屋。\n先确认需求。',
      goal: '',
      allowEdits: false,
    });
    expect(
      validateAICharacter({ ...input, roleDescription: '建'.repeat(2000) }, p)
        .roleDescription,
    ).toHaveLength(2000);
    for (const roleDescription of ['建'.repeat(2001), {}, null, 42]) {
      expect(() =>
        validateAICharacter({ ...input, roleDescription }, p),
      ).toThrow('角色设定');
    }
  });
});
describe('multi-provider SDK requests', () => {
  it.each(['ollama', 'compatible'] as const)(
    'uses %s endpoint without DeepSeek-only parameters',
    async (type) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content:
                    '{"actions":[{"type":"wait"}],"task":{"intent":"continue","status":"completed","summary":"测试决策"}}',
                },
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const endpoint = {
        type,
        baseUrl: 'http://127.0.0.1:11434/v1',
      };
      const config = {
        ...testAgentConfig(),
        model: 'org/model:8b',
      };
      const observation = {
        revision: 1,
        self: {},
        players: [],
        blocks: [],
        events: [],
        radius: 8,
      } as unknown as Observation;
      expect(
        await new ModelPlanner(config, request, endpoint).decide(
          observation,
          null,
          new AbortController().signal,
        ),
      ).toMatchObject({
        actions: [{ type: 'wait' }],
        task: { intent: 'continue', status: 'completed' },
      });
      const [url, init] = request.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
      const body = JSON.parse(init!.body as string);
      expect(body).toMatchObject({
        model: 'org/model:8b',
        max_tokens: 512,
      });
      for (const key of [
        'max_completion_tokens',
        'thinking',
        'reasoning_effort',
        'response_format',
      ])
        expect(body).not.toHaveProperty(key);
      expect(init?.redirect).toBe('error');
    },
  );
  it('discovers model IDs through the configured SDK endpoint', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ id: 'z' }, { id: 'a' }, { id: 'a' }] }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );
    try {
      const catalog = new ModelCatalog({ getRuntime: () => provider() });
      expect(await catalog.models('fixture')).toEqual(['a', 'z']);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.deepseek.com/models',
        expect.objectContaining({ redirect: 'error' }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('managed scheduling validation', () => {
  it('accepts random scheduling and keeps requests finite', () => {
    const base = { name: 'AI', goal: 'Observe' };
    expect(validateAICharacter(base, provider())).toMatchObject({
      intervalMode: 'fixed',
      maxTurns: 100,
    });
    expect(
      validateAICharacter(
        {
          ...base,

          intervalMode: 'random',
          intervalMinMs: 4000,
          intervalMaxMs: 8000,
        },
        provider(),
      ),
    ).toMatchObject({
      intervalMinMs: 4000,
      intervalMaxMs: 8000,
    });
    for (const invalid of [
      { intervalMode: 'bad' },
      { intervalMinMs: 8000, intervalMaxMs: 4000 },
      { intervalMinMs: 999 },
      { intervalMaxMs: 60001 },
      { intervalMinMs: 4000.5 },
    ])
      expect(() =>
        validateAICharacter({ ...base, ...invalid }, provider()),
      ).toThrow();
  });
});

it('migrates legacy permissions and validates canonical capability settings', () => {
  const p = provider();
  const input = { name: 'Capabilities' };
  expect(validateAICharacter(input, p)).toMatchObject({
    skills: [],
    permissions: { move: true, chat: true, place: false, remove: false },
  });
  expect(
    validateAICharacter({ ...input, allowEdits: true }, p).permissions,
  ).toEqual({
    move: true,
    chat: true,
    place: true,
    remove: true,
  });
  const permissions = { move: false, chat: false, place: true, remove: false };
  expect(
    validateAICharacter(
      {
        ...input,
        allowEdits: true,
        permissions,
        skills: ['guide', 'building', 'guide'],
      },
      p,
    ),
  ).toMatchObject({
    permissions,
    allowEdits: false,
    skills: ['building', 'guide'],
  });
  for (const invalid of [
    { permissions: null },
    { permissions: true },
    { permissions: [] },
    { permissions: { move: true } },
    { permissions: { ...permissions, remove: 'true' } },
    { permissions: { ...permissions, shell: true } },
    { skills: 'building' },
    { skills: ['shell'] },
    { skills: null },
  ])
    expect(() => validateAICharacter({ ...input, ...invalid }, p)).toThrow();
});

it('persists provider configurations cleanly and resolves character inference defaults automatically', async () => {
  const store = new MemoryProviderRepository();

  await bootstrapProviders(store);

  await store.save(
    {
      name: 'DeepSeek',
      type: 'deepseek',
      apiKey: 'fixture',
      defaultModel: 'deepseek-flash',
    },
    'deepseek',
  );

  await store.save(
    { ...store.get('deepseek'), defaultModel: 'deepseek-reasoner' },
    'deepseek',
  );

  const restored = new MemoryProviderRepository(store.storage);

  await bootstrapProviders(restored);

  const provider = restored.getRuntime('deepseek');

  expect(provider.defaultModel).toBe('deepseek-reasoner');

  expect('inference' in provider).toBe(false);

  const reasoningRole = validateAICharacter({ name: 'ReasoningBot' }, provider);

  expect(reasoningRole.thinking).toBe('enabled');

  expect(reasoningRole.maxTokens).toBe(4096);

  expect(reasoningRole.timeoutMs).toBe(60000);

  const chatProvider = { ...provider, defaultModel: 'deepseek-chat' };

  const chatRole = validateAICharacter({ name: 'ChatBot' }, chatProvider);

  expect(chatRole.thinking).toBe('disabled');

  expect(chatRole.maxTokens).toBe(512);

  const ollamaProvider = restored.getRuntime('ollama');

  const ollamaRole = validateAICharacter(
    { name: 'LocalBot', model: 'llama3' },
    ollamaProvider,
  );

  expect(ollamaRole.timeoutMs).toBe(120000);

  expect(ollamaRole.maxTokens).toBe(512);

  const customRole = validateAICharacter(
    {
      name: 'Custom',
      timeoutMs: 45000,
      maxTokens: 2048,
      thinking: 'enabled',
    },
    chatProvider,
  );

  expect(customRole.timeoutMs).toBe(45000);

  expect(customRole.maxTokens).toBe(2048);

  expect(customRole.thinking).toBe('enabled');
});

it.each(['deepseek', 'ollama', 'compatible'] as const)(
  'ignores legacy tokenField for %s and saves cleanly',
  (type) => {
    const saved = validateProvider({
      name: 'Field mapping',
      type,
      baseUrl: type === 'compatible' ? 'https://example.com/v1' : undefined,
      tokenField: 'max_completion_tokens',
    });
    expect((saved as Record<string, unknown>).tokenField).toBeUndefined();
    expect(validateProvider(saved, saved)).toEqual(saved);
  },
);
