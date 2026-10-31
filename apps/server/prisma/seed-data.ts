export const DEFAULT_PROVIDERS = [
  {
    id: 'deepseek',
    position: 0,
    name: 'DeepSeek',
    type: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    defaultModel: 'deepseek-flash',
  },
  {
    id: 'ollama',
    position: 1,
    name: 'Ollama',
    type: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    defaultModel: '',
  },
] as const;

export const DEFAULT_TTS_PROVIDER = {
  id: 'local-default',
  position: 0,
  name: 'Speaches 语音服务',
  type: 'speaches',
  baseUrl: '',
  apiKey: '',
  model: '',
  voice: '',
  speed: 1.0,
  voiceLanguage: null,
} as const;
