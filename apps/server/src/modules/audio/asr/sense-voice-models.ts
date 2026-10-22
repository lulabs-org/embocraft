import { env } from '../../../config/env';
import { AppError } from '../../../common/errors';
import { access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SenseVoiceAsrSettings, SenseVoiceLanguage } from '@voxel/shared';

/** Directory names of the k2-fsa SenseVoice packages, e.g. `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`. */
const modelName = /^sherpa-onnx-sense-voice[a-zA-Z0-9._-]{0,90}$/;

export type SenseVoiceModel = {
  /** Model pack directory name, stored in the ASR service profile. */
  name: string;
  dir: string;
  model: string;
  tokens: string;
};

export function senseVoiceRoot() {
  return env.readSpeech().asrModelDir;
}

async function isReadable(path: string) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 1024 * 1024;
  } catch {
    return false;
  }
}

async function readable(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** int8 quantized graphs are what the distributed packs contain; plain `model.onnx` also loads. */
async function inspect(root: string, name: string) {
  const dir = join(root, name);
  if (!(await readable(join(dir, 'tokens.txt')))) return undefined;
  for (const file of ['model.int8.onnx', 'model.onnx']) {
    const model = join(dir, file);
    if (await isReadable(model))
      return { name, dir, model, tokens: join(dir, 'tokens.txt') };
  }
  return undefined;
}

/** Installed packs only; nothing is downloaded automatically. */
export async function listSenseVoiceModels(
  root = senseVoiceRoot(),
): Promise<SenseVoiceModel[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((entry) => entry.isDirectory() && modelName.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const models = await Promise.all(names.map((name) => inspect(root, name)));
  return models.filter((model): model is SenseVoiceModel => !!model);
}

export function assertModelName(model: string) {
  if (model !== 'default' && (!modelName.test(model) || model.includes('..')))
    throw new AppError('请选择服务器已安装的 SenseVoice 模型。');
}

export function validateSenseVoiceSettings(value: {
  [key: string]: unknown;
}): SenseVoiceAsrSettings {
  if (typeof value.model !== 'string')
    throw new AppError('请选择 SenseVoice 模型。');
  assertModelName(value.model);
  if (
    value.language !== 'auto' &&
    value.language !== 'zh' &&
    value.language !== 'en'
  )
    throw new AppError('请选择自动、中文或英文识别语言。');
  return { model: value.model, language: value.language as SenseVoiceLanguage };
}

/** `default` follows `SENSE_VOICE_MODEL` and then the first installed pack. */
export async function resolveSenseVoiceModel(
  model = 'default',
  root = senseVoiceRoot(),
): Promise<SenseVoiceModel> {
  assertModelName(model);
  const models = await listSenseVoiceModels(root);
  if (!models.length)
    throw new AppError(
      '服务器未安装本地 SenseVoice 模型，请将 sherpa-onnx-sense-voice 模型目录放入 models/。',
      503,
    );
  if (model !== 'default') {
    const selected = models.find((value) => value.name === model);
    if (!selected)
      throw new AppError('所选 SenseVoice 模型不可用，请确认模型已安装。', 503);
    return selected;
  }
  const preferred = env.readSpeech().senseVoiceModel;
  return (
    (preferred
      ? models.find((value) => value.name === preferred)
      : undefined) ?? models[0]
  );
}
