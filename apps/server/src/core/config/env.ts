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
const DEFAULT_SPEECH_API_URL = 'http://127.0.0.1:8000/v1';
const DEFAULT_GATEWAY_ORIGINS = [
  'http://localhost',
  'http://127.0.0.1',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

const repositoryRoot = fileURLToPath(
  new URL('../../../../../', import.meta.url),
);

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
    throw new Error('SERVER_PORT 必须是 0..65535 的整数。');
  }
  return port;
}

function parseHost(raw: string | undefined = DEFAULT_HOST): string {
  const host = raw.trim();
  if (!host || /\s|[/?#]/.test(host)) {
    throw new Error('SERVER_HOST 必须是有效的监听主机名或地址。');
  }
  return host;
}

function validateWebOrigin(origin: string): string {
  if (origin !== '*' && !isValidHttpOrigin(origin)) {
    throw new Error('WEB_ORIGIN 必须是 HTTP(S) Origin 或 *。');
  }
  return origin;
}

function parseGatewayToken(raw: string | undefined, isProduction: boolean) {
  const token = raw?.trim() || undefined;
  if (isProduction && !token) {
    throw new Error('生产环境必须配置 AGENT_GATEWAY_TOKEN 环境变量。');
  }
  if (token && (token.length < 24 || token.length > 4096 || /\s/.test(token))) {
    throw new Error('AGENT_GATEWAY_TOKEN 需为 24–4096 个无空白字符。');
  }
  return token;
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

function encryptionSecret(env: EnvLookup = process.env): string | undefined {
  const secret = (env.DATA_ENCRYPTION_KEY ?? '').trim();
  return secret || undefined;
}

function readSpeechConfig(env: EnvLookup = process.env) {
  const asrProvider = (env.ASR_PROVIDER ?? 'auto').trim() || 'auto';
  // 启动时直接报错而不是静默回退，避免拼写错误把请求固定到另一个引擎。
  if (
    asrProvider !== 'auto' &&
    asrProvider !== 'whisper' &&
    asrProvider !== 'sense-voice'
  )
    throw new Error('ASR_PROVIDER 仅支持 auto、whisper 或 sense-voice。');
  return {
    speechApiUrl: (
      env.SPEECH_API_URL?.trim() || DEFAULT_SPEECH_API_URL
    ).replace(/\/+$/, ''),
    asrProvider,
    // SenseVoice 由独立容器提供；留空时 auto 回退 Whisper，保存的配置仍可单独填写地址。
    senseVoiceApiUrl: (env.SENSE_VOICE_API_URL?.trim() ?? '').replace(
      /\/+$/,
      '',
    ),
  };
}
export type AsrProviderName = ReturnType<
  typeof readSpeechConfig
>['asrProvider'];

function readServerConfig(env: EnvLookup = process.env) {
  const port = parsePort(env.SERVER_PORT);
  const host = parseHost(env.SERVER_HOST);
  const origin = validateWebOrigin(webOrigin(env));
  const isProduction = env.NODE_ENV?.trim() === 'production';
  const gatewayOrigins = parseGatewayOrigins(
    env.AGENT_GATEWAY_ALLOWED_ORIGINS,
    origin,
  );

  return {
    port,
    host,
    webOrigin: origin,
    databaseUrl: databaseUrl(env),
    isProduction,
    gateway: {
      token: parseGatewayToken(env.AGENT_GATEWAY_TOKEN, isProduction),
      origins: gatewayOrigins,
    },
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
  encryptionSecret,
  speechEndpoint: (env?: EnvLookup) => readSpeechConfig(env).speechApiUrl,
  readServer: readServerConfig,
  readSpeech: readSpeechConfig,
} as const;

export default env;
