import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig, ModelEndpoint } from '../../contracts/config';
import { createModel } from './pi';
import { providerPayload } from './payload';
import { providerFetch, providerOptions } from './provider';
import { ollamaCompletion } from './ollama';

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
    baseUrl: 'http://localhost:11434',
    jsonMode: true,
    tokenField: 'max_tokens',
  };
}

describe('provider payload policy', () => {
  it('adds thinking controls for DeepSeek', () => {
    const body = { model: 'deepseek-flash', reasoning_effort: 'low' };
    expect(
      providerPayload(
        config({ thinking: 'enabled', reasoningEffort: 'high' }),
        endpoint('deepseek'),
        body,
      ),
    ).toMatchObject({
      model: 'deepseek-flash',
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
  });

  it('removes reasoning effort when DeepSeek thinking is disabled', () => {
    const body = { model: 'deepseek-flash', reasoning_effort: 'high' };
    const payload = providerPayload(
      config({ thinking: 'disabled' }),
      endpoint('deepseek'),
      body,
    );
    expect(payload.thinking).toEqual({ type: 'disabled' });
    expect(payload.reasoning_effort).toBeUndefined();
  });

  it('leaves other providers untouched', () => {
    const body = { model: 'qwen3:8b' };
    expect(providerPayload(config(), endpoint('ollama'), body)).toBe(body);
    expect(providerPayload(config(), endpoint('compatible'), body)).toBe(body);
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

  it('applies the provider payload policy through onPayload', () => {
    const options = providerOptions(
      {
        config: config({ thinking: 'enabled', reasoningEffort: 'low' }),
        endpoint: endpoint('deepseek'),
        model: createModel(config(), endpoint('deepseek')),
        request: vi.fn<typeof fetch>(),
      },
      () => {},
    );
    expect(
      options.onPayload?.({ model: 'deepseek-flash' }, undefined as never),
    ).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    });
  });
});
