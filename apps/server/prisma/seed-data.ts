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
  model: 'speaches-ai/piper-zh_CN-huayan-medium',
  voice: 'huayan',
  speed: 1.0,
  voiceLanguage: null,
} as const;

export const DEFAULT_ASR_PROVIDER = {
  id: 'local-default',
  position: 0,
  name: 'Speaches 识别服务',
  provider: 'whisper',
  model: 'Systran/faster-whisper-base',
  apiKey: '',
  region: null,
  workspaceId: null,
  baseUrl: '',
  temperature: 0,
  prompt: '',
} as const;

export const DEFAULT_CHARACTER = {
  id: 'default-character',
  providerId: 'deepseek',
  position: 0,
  name: 'AI 探索者',
  model: 'deepseek-flash',
  roleDescription:
    '你是一名在体素世界中探索的 AI 伙伴。你可以自由移动、观察周围环境，并与玩家友好地交谈。',
  taskLimitsEnabled: true,
  maxTurns: 100,
  maxStalledTurns: 3,
  tokenBudget: 50000,
  taskTimeoutMs: 900000,
  intervalMode: 'fixed',
  intervalMinMs: 4000,
  intervalMaxMs: 8000,
  intervalMs: 3000,
  timeoutMs: 60000,
  maxTokens: 512,
  permissions: { move: true, chat: true, place: false, remove: false },
  skills: [],
  voiceReplies: true,
  voiceServiceId: 'local-default',
  thinking: 'disabled',
  reasoningEffort: 'high',
} as const;

