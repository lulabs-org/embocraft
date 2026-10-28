import { normalizeContext } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig, ModelEndpoint } from '../../contracts/config';
import { createModel, resolveMaxTokensField } from './pi';
import { providerOptions } from './stream';

/** Explicit inputs; independent of CLI defaults and the developer's environment. */
function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    apiKey: 'fixture',
    name: 'Test Agent',
    model: 'deepseek-flash',
    goal: '观察附近环境并回应玩家。',
    permissions: { move: true, chat: true, place: false, remove: false },
    voiceReplies: false,

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

  it('automatically resolves maxTokensField based on model name', () => {
    expect(resolveMaxTokensField('o1')).toBe('max_completion_tokens');
    expect(resolveMaxTokensField('o1-mini')).toBe('max_completion_tokens');
    expect(resolveMaxTokensField('o1-preview')).toBe('max_completion_tokens');
    expect(resolveMaxTokensField('o3-mini')).toBe('max_completion_tokens');
    expect(resolveMaxTokensField('openai/o1')).toBe('max_completion_tokens');
    expect(resolveMaxTokensField('gpt-4o')).toBe('max_tokens');
    expect(resolveMaxTokensField('deepseek-chat')).toBe('max_tokens');
    expect(resolveMaxTokensField('qwen2.5:7b')).toBe('max_tokens');

    const o1Model = createModel(
      config({ model: 'o1-mini' }),
      endpoint('compatible'),
    );
    expect(o1Model.compat?.maxTokensField).toBe('max_completion_tokens');

    const standardModel = createModel(
      config({ model: 'gpt-4o' }),
      endpoint('compatible'),
    );
    expect(standardModel.compat?.maxTokensField).toBe('max_tokens');
  });
});

describe('provider transport and options', () => {
  it('rejects redirects and reports the HTTP status', async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response('{}', { status: 503 }),
    );
    const statuses: number[] = [];
    const options = providerOptions(
      config(),
      endpoint('compatible'),
      request,
      (status) => statuses.push(status),
    );
    const response = await options.fetch!(
      'https://example.test/v1/chat/completions',
      { method: 'POST' },
    );
    expect(response.status).toBe(503);
    expect(statuses).toEqual([503]);
    expect(request).toHaveBeenCalledWith(
      'https://example.test/v1/chat/completions',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('pins the request policy for one model call', () => {
    const options = providerOptions(
      config({ apiKey: '' }),
      endpoint('deepseek'),
      vi.fn<typeof fetch>(),
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
      config({ thinking: 'enabled', reasoningEffort: 'low' }),
      endpoint('deepseek'),
      vi.fn<typeof fetch>(),
      () => {},
    );
    expect(options.reasoningEffort).toBe('low');
  });

  it('omits reasoningEffort when DeepSeek thinking is disabled', () => {
    const options = providerOptions(
      config({ thinking: 'disabled', reasoningEffort: 'high' }),
      endpoint('deepseek'),
      vi.fn<typeof fetch>(),
      () => {},
    );
    expect(options.reasoningEffort).toBeUndefined();
  });

  it('omits reasoningEffort for non-DeepSeek endpoints', () => {
    const options = providerOptions(
      config({ thinking: 'enabled', reasoningEffort: 'high' }),
      endpoint('compatible'),
      vi.fn<typeof fetch>(),
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
    const options = providerOptions(cfg, ep, request, () => {});
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
    const options = providerOptions(cfg, ep, request, () => {});
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
