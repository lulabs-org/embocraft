import { access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../../../../core/config/env';
import { AppError } from '../../../../core/errors/app-error';

/** k2-fsa SenseVoice 模型包的目录名，例如 sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17。 */
const modelName = /^sherpa-onnx-sense-voice[a-zA-Z0-9._-]{0,90}$/;

export type SenseVoiceModel = {
  /** 模型包目录名，保存在 ASR 服务配置中。 */
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

/** 分发包中是 int8 量化图，普通的 model.onnx 也支持加载。 */
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

/** 只列出已安装的模型包，不会自动下载任何内容。 */
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

/** default 先跟随 SENSE_VOICE_MODEL，再回退到第一个已安装的模型包。 */
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
