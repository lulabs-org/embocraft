import { describe, expect, it } from 'vitest';
import {
  resolveInferenceDefaults,
  validateInferenceSettings,
  validateProviderModel,
} from './inference';
import { validateProvider } from './validation';

describe('provider model capabilities', () => {
  it('resolves defaults from the provider and selected model', () => {
    expect(resolveInferenceDefaults('deepseek-reasoner', 'deepseek')).toEqual({
      thinking: 'enabled',
      reasoningEffort: 'high',
      timeoutMs: 60000,
      maxTokens: 4096,
    });
    expect(resolveInferenceDefaults('deepseek-chat', 'deepseek')).toMatchObject(
      {
        thinking: 'disabled',
        maxTokens: 512,
      },
    );
    expect(resolveInferenceDefaults('qwen-r1', 'ollama')).toMatchObject({
      thinking: 'enabled',
      timeoutMs: 120000,
      maxTokens: 4096,
    });
    expect(resolveInferenceDefaults('llama3', 'ollama')).toMatchObject({
      thinking: 'disabled',
      timeoutMs: 120000,
      maxTokens: 512,
    });
    expect(resolveInferenceDefaults('o1', 'compatible')).toMatchObject({
      thinking: 'enabled',
      timeoutMs: 60000,
      maxTokens: 4096,
    });
    expect(resolveInferenceDefaults('gpt-4o', 'compatible')).toMatchObject({
      thinking: 'disabled',
      timeoutMs: 60000,
      maxTokens: 512,
    });
  });

  it('validates model selection and provider requirements', () => {
    const deepseek = validateProvider({
      name: 'DeepSeek',
      type: 'deepseek',
      apiKey: 'fixture',
      defaultModel: 'deepseek-chat',
    });
    const ollama = validateProvider({ name: 'Local', type: 'ollama' });
    expect(validateProviderModel(undefined, deepseek)).toBe('deepseek-chat');
    expect(validateProviderModel('qwen3:8b', ollama)).toBe('qwen3:8b');
    expect(() => validateProviderModel('bad model', deepseek)).toThrow(
      '请输入有效模型 ID。',
    );
    expect(() => validateProviderModel('model-cloud', ollama)).toThrow(
      'Ollama 请选择已安装在目标服务上的模型。',
    );
    expect(() =>
      validateProviderModel(undefined, { ...deepseek, apiKey: '' }),
    ).toThrow('API Key');
  });

  it('keeps explicit inference settings across providers', () => {
    expect(
      validateInferenceSettings(
        { thinking: 'enabled', reasoningEffort: 'low', timeoutMs: 45000 },
        'deepseek-chat',
        'deepseek',
      ),
    ).toEqual({
      thinking: 'enabled',
      reasoningEffort: 'low',
      timeoutMs: 45000,
      maxTokens: 4096,
    });
    expect(
      validateInferenceSettings({ thinking: 'enabled' }, 'llama3', 'ollama'),
    ).toMatchObject({
      thinking: 'enabled',
      timeoutMs: 120000,
      maxTokens: 4096,
    });
    expect(() =>
      validateInferenceSettings({ thinking: 'invalid' }, 'llama3', 'ollama'),
    ).toThrow('思考模式无效。');
  });
});
