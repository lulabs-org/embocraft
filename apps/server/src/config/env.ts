import { config as dotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// 1. Types & Internal Constants
// ---------------------------------------------------------------------------

export type EnvLookup = Record<string, string | undefined>;

const DEFAULT_PORT = 2567;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_WEB_ORIGIN = 'http://127.0.0.1:5173';
const DEFAULT_GATEWAY_ORIGINS = [
  'http://localhost',
  'http://127.0.0.1',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

const VALID_VOICE_PROVIDERS = ['mock', 'browser', 'ollama'] as const;
type VoiceProvider = (typeof VALID_VOICE_PROVIDERS)[number];

export const VALID_ASR_PROVIDERS = ['auto', 'whisper', 'sense-voice'] as const;
export type AsrProviderName = (typeof VALID_ASR_PROVIDERS)[number];

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const dataPath = (name: string): string =>
  resolve(repositoryRoot, '.data', name);

// ---------------------------------------------------------------------------
// 2. Parsers & Validation Helpers (Internal)
// ---------------------------------------------------------------------------

function isValidHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

function parsePort(
  raw: string | undefined,
  defaultPort = DEFAULT_PORT,
): number {
  const port = Number(raw ?? defaultPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT 必须是 0..65535 的整数。');
  }
  return port;
}

function parseHost(raw: string | undefined = DEFAULT_HOST): string {
  const host = raw.trim();
  if (!host || /\s|[/?#]/.test(host)) {
    throw new Error('HOST 必须是有效的监听主机名或地址。');
  }
  return host;
}

function validateWebOrigin(origin: string): string {
  if (origin !== '*' && !isValidHttpOrigin(origin)) {
    throw new Error('WEB_ORIGIN 必须是 HTTP(S) Origin 或 *。');
  }
  return origin;
}

function parseGatewayOrigins(
  raw: string | undefined,
  currentWebOrigin: string,
): string[] {
  const source =
    raw ??
    (currentWebOrigin !== '*'
      ? currentWebOrigin
      : DEFAULT_GATEWAY_ORIGINS.join(','));

  const origins = source.split(',').map((value) => value.trim());
  for (const value of origins) {
    if (!isValidHttpOrigin(value)) {
      throw new Error(
        'AGENT_GATEWAY_ALLOWED_ORIGINS 必须是明确的 HTTP(S) Origin 列表，不能使用 *。',
      );
    }
  }

  return origins;
}

function assertValidVoiceProvider(
  provider: string,
): asserts provider is VoiceProvider {
  if (!VALID_VOICE_PROVIDERS.includes(provider as VoiceProvider)) {
    throw new Error('VOICE_PROVIDER 仅支持 mock、browser 或 ollama。');
  }
}

// ---------------------------------------------------------------------------
// 3. Config Readers
// ---------------------------------------------------------------------------

/** Only the executable entrypoint loads dotenv. Importing app/server has no environment side effects. */
function loadEnvironment() {
  dotenv({ path: resolve(repositoryRoot, '.env') });
  return readServerConfig();
}

function webOrigin(env: EnvLookup = process.env): string {
  return env.WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN;
}

function databaseUrl(env: EnvLookup = process.env): string {
  return env.DATABASE_URL ?? '';
}

function readVoiceConfig(env: EnvLookup = process.env) {
  return {
    provider: (env.VOICE_PROVIDER ?? 'mock') as string,
    ollamaModel: env.OLLAMA_MODEL ?? '',
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
  };
}

function readSpeechConfig(env: EnvLookup = process.env) {
  const asrProvider = (env.ASR_PROVIDER ?? 'auto').trim() || 'auto';
  if (!VALID_ASR_PROVIDERS.includes(asrProvider as AsrProviderName))
    throw new Error('ASR_PROVIDER 仅支持 auto、whisper 或 sense-voice。');
  const threads = Number(env.ASR_THREADS ?? 2);
  if (!Number.isInteger(threads) || threads < 1 || threads > 16)
    throw new Error('ASR_THREADS 须为 1–16 的整数。');
  return {
    path: env.PATH ?? '',
    whisperModel: env.WHISPER_MODEL,
    whisperBin: env.WHISPER_BIN,
    ffmpegBin: env.FFMPEG_BIN ?? 'ffmpeg',
    whisperApiUrl: env.WHISPER_API_URL,
    speechApiUrl: env.SPEECH_API_URL,
    piperApiUrl: env.PIPER_API_URL,
    asrProvider: asrProvider as AsrProviderName,
    asrModelDir: env.ASR_MODEL_DIR?.trim() || resolve(repositoryRoot, 'models'),
    senseVoiceModel: env.SENSE_VOICE_MODEL?.trim() ?? '',
    asrThreads: threads,
  };
}

function readProviderDefaults(env: EnvLookup = process.env) {
  return {
    deepseekApiKey: env.DEEPSEEK_API_KEY ?? '',
    deepseekModel: env.DEEPSEEK_MODEL || 'deepseek-flash',
    ollamaModel: env.OLLAMA_MODEL ?? '',
  };
}

function readRealtimeConfig(env: EnvLookup = process.env) {
  return {
    enabled: env.BAILIAN_REALTIME_ENABLED === 'true',
    workspace: env.BAILIAN_WORKSPACE_ID ?? '',
    model: env.BAILIAN_REALTIME_MODEL,
    voice: env.BAILIAN_REALTIME_VOICE,
    credential: () => env.DASHSCOPE_API_KEY ?? '',
  };
}

function readServerConfig(env: EnvLookup = process.env) {
  const port = parsePort(env.PORT);
  const host = parseHost(env.HOST);
  const origin = validateWebOrigin(webOrigin(env));
  const gatewayOrigins = parseGatewayOrigins(
    env.AGENT_GATEWAY_ALLOWED_ORIGINS,
    origin,
  );
  const voice = readVoiceConfig(env);
  assertValidVoiceProvider(voice.provider);

  return {
    port,
    host,
    webOrigin: origin,
    databaseUrl: databaseUrl(env),
    voice: {
      ...voice,
      provider: voice.provider as VoiceProvider,
    },
    gateway: {
      token: env.AGENT_GATEWAY_TOKEN,
      tokenFile:
        env.AGENT_GATEWAY_TOKEN_FILE || dataPath('agent-gateway-token'),
      origins: gatewayOrigins,
    },
    realtime: readRealtimeConfig(env),
  };
}

export type ServerConfig = ReturnType<typeof readServerConfig>;

// ---------------------------------------------------------------------------
// 4. Unified Export
// ---------------------------------------------------------------------------

/**
 * 统一环境与配置入口
 */
export const env = {
  root: repositoryRoot,
  dataPath,
  load: loadEnvironment,
  webOrigin,
  databaseUrl,
  readServer: readServerConfig,
  readVoice: readVoiceConfig,
  readSpeech: readSpeechConfig,
  readProviders: readProviderDefaults,
  readRealtime: readRealtimeConfig,
} as const;

export type AppEnv = typeof env;
export default env;
