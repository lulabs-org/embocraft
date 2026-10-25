import { expect, it } from 'vitest';
import { validateProvider } from '../provider-validation';
import { toProviderView } from './model';
import { validateProviderInput } from './validation';

it('applies provider defaults and validates fields without assigning an ID', () => {
  expect(
    validateProviderInput({ name: ' DeepSeek ', type: 'deepseek' }),
  ).toEqual({
    name: 'DeepSeek',
    type: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    defaultModel: '',
  });
  expect(() => validateProviderInput({ name: '', type: 'deepseek' })).toThrow(
    '请输入服务名称。',
  );
  expect(() =>
    validateProviderInput({ name: 'Other', type: 'unknown' }),
  ).toThrow('不支持此服务类型。');
});

it('enforces provider-specific URL and protocol rules', () => {
  expect(() =>
    validateProviderInput({
      name: 'DeepSeek',
      type: 'deepseek',
      baseUrl: 'https://gateway.example.com',
    }),
  ).toThrow('DeepSeek 使用官方地址');
  expect(() =>
    validateProviderInput({
      name: 'Ollama',
      type: 'ollama',
      baseUrl: 'https://public.example.com/v1',
    }),
  ).toThrow('Ollama 仅支持本机或局域网私有 IP 地址。');
  expect(
    validateProviderInput({
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
      validateProviderInput({ name: 'Other', type: 'compatible', baseUrl }),
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
