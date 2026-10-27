import { env } from '../../../../core/config/env';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WhisperAsrSettings } from '@voxel/shared';
import { AppError } from '../../../../core/errors/app-error';

export const whisperModelsDirectory = env.dataPath('voice/');
const modelName = /^ggml-[a-zA-Z0-9][a-zA-Z0-9._-]{0,90}\.bin$/;
export function whisperModelPath(model: string, fallback: string) {
  if (model === 'default') return fallback;
  if (!modelName.test(model) || model.includes('..'))
    throw new AppError('请选择服务器已安装的 Whisper 模型。');
  return join(whisperModelsDirectory, model);
}
export async function listWhisperModels() {
  const entries = await readdir(whisperModelsDirectory, {
    withFileTypes: true,
  }).catch(() => []);
  return [
    'default',
    ...entries
      .filter(
        (entry) =>
          entry.isFile() &&
          modelName.test(entry.name) &&
          !entry.name.includes('..'),
      )
      .map((entry) => entry.name)
      .sort(),
  ];
}
export function validateWhisperSettings(
  value: Record<string, unknown>,
): WhisperAsrSettings {
  if (typeof value.model !== 'string')
    throw new AppError('请选择 Whisper 模型。');
  whisperModelPath(value.model, 'default');
  if (
    !Number.isInteger(value.threads) ||
    Number(value.threads) < 1 ||
    Number(value.threads) > 16
  )
    throw new AppError('线程数须为 1–16 的整数。');
  if (
    !Number.isInteger(value.beamSize) ||
    Number(value.beamSize) < 1 ||
    Number(value.beamSize) > 8
  )
    throw new AppError('搜索宽度须为 1–8 的整数。');
  if (
    typeof value.temperature !== 'number' ||
    !Number.isFinite(value.temperature) ||
    value.temperature < 0 ||
    value.temperature > 1
  )
    throw new AppError('采样温度须在 0–1 之间。');
  if (
    typeof value.prompt !== 'string' ||
    value.prompt.length > 500 ||
    value.prompt.includes('\0')
  )
    throw new AppError('提示词不能超过 500 字或包含空字符。');
  return {
    model: value.model,
    threads: Number(value.threads),
    beamSize: Number(value.beamSize),
    temperature: value.temperature,
    prompt: value.prompt.trim(),
  };
}
