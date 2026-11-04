import { DEFAULT_BAILIAN_ASR, DEFAULT_WHISPER_ASR } from '@voxel/shared';
import { describe, expect, it } from 'vitest';
import {
  bailianAsrEndpoint,
  validateAsrService,
  validateBailianSettings,
  validateWhisperSettings,
} from './validation';
import { toAsrServiceView } from './model';

describe('Bailian settings validation & endpoints', () => {
  const draft = {
    ...DEFAULT_BAILIAN_ASR,
    name: '模型 A',
    apiKey: 'secret-for-test',
  };

  it('generates correct endpoints for beijing and singapore with or without workspaceId', () => {
    expect(
      bailianAsrEndpoint({ ...draft, region: 'beijing', workspaceId: '' }),
    ).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/inference');
    expect(
      bailianAsrEndpoint({ ...draft, region: 'singapore', workspaceId: '' }),
    ).toBe('wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference');
    expect(
      bailianAsrEndpoint({
        ...draft,
        region: 'singapore',
        workspaceId: 'ws-123',
      }),
    ).toBe('wss://ws-123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference');
    expect(
      bailianAsrEndpoint({
        ...draft,
        region: 'beijing',
        workspaceId: 'ws-beijing',
      }),
    ).toBe('wss://ws-beijing.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference');
  });

  it('validates required fields and constraints', () => {
    expect(() =>
      validateBailianSettings(
        { ...draft, apiKey: '', region: 'singapore' },
        draft,
      ),
    ).toThrow('重新填写');
    expect(() =>
      validateBailianSettings(
        { ...draft, apiKey: '', workspaceId: 'other' },
        draft,
      ),
    ).toThrow('重新填写');
    expect(() =>
      validateBailianSettings({ ...draft, workspaceId: 'example.com/path' }),
    ).toThrow('业务空间 ID');
    expect(() =>
      validateBailianSettings({ ...draft, apiKey: 'key\nheader' }),
    ).toThrow('API Key');
    expect(() =>
      validateBailianSettings({ ...draft, model: 'qwen-tts' }),
    ).toThrow('实时识别模型');
  });
});

describe('Whisper settings validation', () => {
  const base = {
    ...DEFAULT_WHISPER_ASR,
    name: 'Speaches',
    baseUrl: 'http://localhost:8000/v1',
    apiKey: 'secret',
    model: 'whisper-large-v3-turbo',
  };

  it('validates model, temperature, and prompt', () => {
    expect(validateWhisperSettings(base)).toMatchObject({
      baseUrl: 'http://localhost:8000/v1',
      model: 'whisper-large-v3-turbo',
    });

    expect(() =>
      validateWhisperSettings({ ...base, temperature: 1.5 }),
    ).toThrow('采样温度');
    expect(() =>
      validateWhisperSettings({ ...base, temperature: -0.1 }),
    ).toThrow('采样温度');
    expect(() =>
      validateWhisperSettings({ ...base, prompt: 'x'.repeat(501) }),
    ).toThrow('提示词');
    expect(() =>
      validateWhisperSettings({ ...base, model: '../etc/passwd' }),
    ).toThrow('模型');
  });
});

describe('General ASR Service entity validation & view', () => {
  it('validates service names and generates IDs', () => {
    expect(() =>
      validateAsrService({ ...DEFAULT_BAILIAN_ASR, name: '', apiKey: 'key' }),
    ).toThrow('名称');

    const created = validateAsrService({
      ...DEFAULT_BAILIAN_ASR,
      name: '百炼服务',
      apiKey: 'key',
    });
    expect(created.id).toBeDefined();
    expect(created.name).toBe('百炼服务');

    const updated = validateAsrService(
      { ...DEFAULT_BAILIAN_ASR, name: '新名称', apiKey: 'new-key' },
      created,
    );
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('新名称');
  });

  it('rejects provider changes on existing services', () => {
    const existing = validateAsrService({
      ...DEFAULT_BAILIAN_ASR,
      name: '百炼',
      apiKey: 'key',
    });

    expect(() =>
      validateAsrService(
        {
          ...DEFAULT_WHISPER_ASR,
          provider: 'whisper',
          name: '换成 Whisper',
        },
        existing,
      ),
    ).toThrow('已有服务不能更改类型');
  });

  it('masks apiKey in toAsrServiceView', () => {
    const service = validateAsrService({
      ...DEFAULT_BAILIAN_ASR,
      name: '百炼',
      apiKey: 'super-secret',
    });
    const view = toAsrServiceView(service);
    expect(view.hasApiKey).toBe(true);
    expect((view as Record<string, unknown>).apiKey).toBeUndefined();
  });
});

describe('live transcription settings', () => {
  it.each([
    ['openai', 'gpt-live-transcribe'],
    ['gemini', 'gemini-3.5-transcribe-live'],
  ] as const)(
    'validates and redacts %s credentials while retaining saved keys',
    (provider, model) => {
      const saved = validateAsrService({
        provider,
        model,
        name: 'Live',
        apiKey: 'secret',
      });
      expect(toAsrServiceView(saved)).toMatchObject({
        provider,
        model,
        hasApiKey: true,
      });
      expect(toAsrServiceView(saved)).not.toHaveProperty('apiKey');
      expect(
        validateAsrService(
          { provider, model, name: 'Edited', apiKey: '' },
          saved,
        ).apiKey,
      ).toBe('secret');
      expect(() =>
        validateAsrService({ provider, model, name: 'Live', apiKey: '' }),
      ).toThrow('API Key');
      expect(() =>
        validateAsrService({ provider, model, name: 'Live', apiKey: 'x\ny' }),
      ).toThrow('API Key');
      expect(() =>
        validateAsrService({
          provider,
          model: 'other',
          name: 'Live',
          apiKey: 'x',
        }),
      ).toThrow('模型');
    },
  );
});
