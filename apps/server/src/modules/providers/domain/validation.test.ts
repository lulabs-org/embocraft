import { expect, it } from 'vitest';
import { toProviderView } from './model';
import { validateProvider } from './validation';

it('applies provider defaults and validates fields', () => {
  const provider = validateProvider({ name: ' DeepSeek ', type: 'deepseek' });
  expect(provider).toMatchObject({
    name: 'DeepSeek',
    type: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    defaultModel: '',
  });
  expect(provider.id).toBeDefined();

  expect(() => validateProvider({ name: '', type: 'deepseek' })).toThrow(
    '请输入服务名称。',
  );
  expect(() =>
    validateProvider({ name: 'Other', type: 'unknown' }),
  ).toThrow('不支持此服务类型。');
});

it('enforces provider-specific URL and protocol rules', () => {
  expect(() =>
    validateProvider({
      name: 'DeepSeek',
      type: 'deepseek',
      baseUrl: 'https://gateway.example.com',
    }),
  ).toThrow('DeepSeek 使用官方地址');
  expect(
    validateProvider({
      name: 'Ollama',
      type: 'ollama',
      baseUrl: 'https://public.example.com/v1',
    }).baseUrl,
  ).toBe('https://public.example.com/v1');
  expect(
    validateProvider({
      name: 'Ollama',
      type: 'ollama',
      baseUrl: 'http://192.168.1.5:11434/v1/',
    }).baseUrl,
  ).toBe('http://192.168.1.5:11434/v1');
  for (const baseUrl of [
    'http://gateway.example.com/v1',
    'https://user:pass@gateway.example.com/v1',
    'https://gateway.example.com/v1?token=secret',
    'https://gateway.example.com/v1#fragment',
  ]) {
    expect(() =>
      validateProvider({ name: 'Other', type: 'compatible', baseUrl }),
    ).toThrow('接口须为 HTTPS 或本机 HTTP 地址');
  }
});

it('keeps update key inheritance outside domain validation and redacts views', () => {
  const saved = validateProvider({
    name: 'Gateway',
    type: 'compatible',
    baseUrl: 'https://gateway.example.com/v1',
    apiKey: 'secret',
  });
  const updated = validateProvider(
    {
      name: 'Gateway 2',
      type: 'compatible',
      baseUrl: 'https://gateway.example.com/v2',
    },
    saved,
  );
  expect(updated).toMatchObject({ id: saved.id, apiKey: 'secret' });
  expect(toProviderView(updated)).toMatchObject({ hasApiKey: true });
  expect(toProviderView(updated)).not.toHaveProperty('apiKey');
  expect(() =>
    validateProvider(
      {
        name: 'New host',
        type: 'compatible',
        baseUrl: 'https://other.example.com/v1',
      },
      saved,
    ),
  ).toThrow('更换服务地址或类型时，请重新填写 API Key。');
});

it('validates both ID format and provider fields', () => {
  const restored = validateProvider({
    id: 'deepseek-custom',
    name: 'DeepSeek',
    type: 'deepseek',
    apiKey: 'my-key',
  });
  expect(restored).toEqual({
    id: 'deepseek-custom',
    name: 'DeepSeek',
    type: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'my-key',
    defaultModel: '',
  });

  expect(() =>
    validateProvider({ id: '', name: 'Test', type: 'deepseek' }),
  ).toThrow('无效的模型服务 ID。');
  expect(() =>
    validateProvider({
      id: 'bad id with spaces',
      name: 'Test',
      type: 'deepseek',
    }),
  ).toThrow('无效的模型服务 ID。');
  expect(() =>
    validateProvider({ id: 'valid-id', name: '', type: 'deepseek' }),
  ).toThrow('请输入服务名称。');
});
