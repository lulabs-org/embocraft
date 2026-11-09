import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { MimoTts } from '../../src/modules/tts/adapters/mimo-tts.adapter';
import { validateVoiceService } from '../../src/modules/tts/domain/voice-service-validation';

// Real-provider smoke test: requires xiaomi_api_key in the repository .env.
loadEnv({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });
const apiKey = process.env.xiaomi_api_key?.trim();
if (!apiKey)
  throw new Error('缺少 xiaomi_api_key，无法联调小米 MiMo 语音合成。');

const voice = validateVoiceService({
  name: 'MiMo smoke',
  type: 'mimo',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5-tts',
  voice: 'mimo_default',
  speed: 1,
  apiKey,
});
const result = await new MimoTts(voice).synthesize(
  '你好，我是小米 MiMo 语音合成联调测试。',
  AbortSignal.timeout(60000),
);
assert(result.bytes.subarray(0, 4).toString('ascii') === 'RIFF');
const output = fileURLToPath(
  new URL('../../../../output/mimo-smoke.wav', import.meta.url),
);
await mkdir(fileURLToPath(new URL('../../../../output', import.meta.url)), {
  recursive: true,
});
await writeFile(output, result.bytes);
console.log(
  `MiMo TTS OK: ${result.durationMs} ms, ${result.bytes.length} bytes -> ${output}`,
);
