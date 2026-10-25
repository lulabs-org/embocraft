import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig, ModelEndpoint } from '../../contracts/config';
import { createModel } from './pi';
import { providerFetch, providerOptions } from './provider';
import { ollamaCompletion } from './ollama';
import { normalizeContext } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';

vi.mock('./ollama', () => ({ ollamaCompletion: vi.fn() }));

/** Explicit inputs; independent of CLI defaults and the developer's environment. */
function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    apiKey: 'fixture',
    name: 'Test Agent',
    model: 'deepseek-flash',
    goal: '观察附近环境并回应玩家。',
    allowEdits: false,
    voiceReplies: false,
    continuous: false,
    intervalMode: 'fixed',
    intervalMinMs: 4000,
    intervalMaxMs: 8000,
    thinking: 'disabled',
    reasoningEffort: 'high',
    maxTokens: 512,
    maxTurns: 100,
    tokenBudget: 50000,
    taskTimeoutMs: 900000,
    intervalMs: 3000,
    timeoutMs: 30000,
    ...overrides,
  };
}

function endpoint(type: ModelEndpoint['type']): ModelEndpoint {
  return {
    type,
    baseUrl:
      type === 'deepseek'
        ? 'https://api.deepseek.com'
        : 'http://localhost:11434',
    jsonMode: true,
    tokenField: 'max_tokens',
  };
}

describe('model definition and thinking policy', () => {
  it('configures DeepSeek reasoning capability and delegates compat to pi-ai detectCompat', () => {
    const deepseekModel = createModel(
      config({ thinking: 'enabled' }),
      endpoint('deepseek'),
    );
    expect(deepseekModel.reasoning).toBe(true);
    expect(deepseekModel.compat).toBeUndefined();
  });

  it('keeps non-DeepSeek endpoints free of DeepSeek thinkingFormat', () => {
    const ollamaModel = createModel(config(), endpoint('ollama'));
    const compatModel = createModel(config(), endpoint('compatible'));
    expect(ollamaModel.compat?.thinkingFormat).toBeUndefined();
    expect(compatModel.compat?.thinkingFormat).toBeUndefined();
  });
});

describe('provider transport', () => {
  it('rejects redirects and reports the HTTP status', async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response('{}', { status: 503 }),
    );
    const statuses: number[] = [];
    const response = await providerFetch(
      {
        config: config(),
        endpoint: endpoint('compatible'),
        model: createModel(config(), endpoint('compatible')),
        request,
      },
      (status) => statuses.push(status),
    )('https://example.test/v1/chat/completions', { method: 'POST' });
    expect(response.status).toBe(503);
    expect(statuses).toEqual([503]);
    expect(request).toHaveBeenCalledWith(
      'https://example.test/v1/chat/completions',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('routes Ollama through the native chat adapter', async () => {
    const request = vi.fn<typeof fetch>();
    const response = new Response('{}', { status: 200 });
    vi.mocked(ollamaCompletion).mockResolvedValue(response);
    const statuses: number[] = [];
    const init = { method: 'POST', body: '{}' };
    await providerFetch(
      {
        config: config({ thinking: 'enabled' }),
        endpoint: endpoint('ollama'),
        model: createModel(config(), endpoint('ollama')),
        request,
      },
      (status) => statuses.push(status),
    )('http://localhost:11434/v1/chat/completions', init);
    expect(ollamaCompletion).toHaveBeenCalledWith(
      'http://localhost:11434/v1/chat/completions',
      init,
      request,
      32768,
      true,
    );
    expect(request).not.toHaveBeenCalled();
    expect(statuses).toEqual([200]);
  });
});

describe('provider request options', () => {
  it('pins the request policy for one model call', () => {
    const options = providerOptions(
      {
        config: config({ apiKey: '' }),
        endpoint: endpoint('deepseek'),
        model: createModel(config(), endpoint('deepseek')),
        request: vi.fn<typeof fetch>(),
      },
      () => {},
    );
    expect(options).toMatchObject({
      apiKey: 'ollama',
      maxRetries: 0,
      toolChoice: 'required',
      cacheRetention: 'none',
      timeoutMs: 30000,
    });
  });

  it('sets reasoningEffort for DeepSeek when thinking is enabled', () => {
    const options = providerOptions(
      {
        config: config({ thinking: 'enabled', reasoningEffort: 'low' }),
        endpoint: endpoint('deepseek'),
        model: createModel(config(), endpoint('deepseek')),
        request: vi.fn<typeof fetch>(),
      },
      () => {},
    );
    expect(options.reasoningEffort).toBe('low');
  });

  it('omits reasoningEffort when DeepSeek thinking is disabled', () => {
    const options = providerOptions(
      {
        config: config({ thinking: 'disabled', reasoningEffort: 'high' }),
        endpoint: endpoint('deepseek'),
        model: createModel(config(), endpoint('deepseek')),
        request: vi.fn<typeof fetch>(),
      },
      () => {},
    );
    expect(options.reasoningEffort).toBeUndefined();
  });

  it('omits reasoningEffort for non-DeepSeek endpoints', () => {
    const options = providerOptions(
      {
        config: config({ thinking: 'enabled', reasoningEffort: 'high' }),
        endpoint: endpoint('compatible'),
        model: createModel(config(), endpoint('compatible')),
        request: vi.fn<typeof fetch>(),
      },
      () => {},
    );
    expect(options.reasoningEffort).toBeUndefined();
  });
});

describe('end-to-end thinking payload via pi-ai stream', () => {
  it('injects thinking and reasoning_effort into request body for DeepSeek when enabled', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: '1', choices: [] }));
    });
    const cfg = config({ thinking: 'enabled', reasoningEffort: 'high' });
    const ep = endpoint('deepseek');
    const model = createModel(cfg, ep);
    const options = providerOptions(
      { config: cfg, endpoint: ep, model, request },
      () => {},
    );
    const s = stream(
      model,
      normalizeContext({
        messages: [{ role: 'user', content: 'test', timestamp: 1 }],
      }),
      options,
    );
    for await (const event of s) {
      expect(event).toBeDefined();
    }
    expect(capturedBody).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
  });

  it('disables thinking and omits reasoning_effort for DeepSeek when disabled', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: '1', choices: [] }));
    });
    const cfg = config({ thinking: 'disabled', reasoningEffort: 'high' });
    const ep = endpoint('deepseek');
    const model = createModel(cfg, ep);
    const options = providerOptions(
      { config: cfg, endpoint: ep, model, request },
      () => {},
    );
    const s = stream(
      model,
      normalizeContext({
        messages: [{ role: 'user', content: 'test', timestamp: 1 }],
      }),
      options,
    );
    for await (const event of s) {
      expect(event).toBeDefined();
    }
    expect(capturedBody).toMatchObject({
      thinking: { type: 'disabled' },
    });
    expect(capturedBody?.reasoning_effort).toBeUndefined();
  });
});
