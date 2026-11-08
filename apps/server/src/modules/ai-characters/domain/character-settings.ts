import {
  AI_CHARACTER_PERMISSIONS,
  AI_CHARACTER_ROLE_DESCRIPTION_LIMIT,
  AI_CHARACTER_SKILLS,
  resolvePermissions,
  type AICharacterPermissions,
  type AICharacterSettings,
  type AICharacterSkillId,
} from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import { boolean, integer, object, text } from '../../../core/http/validation';
import {
  validateInferenceSettings,
  validateProviderModel,
  type SavedProvider,
} from '../../providers';

export function validateAICharacter(
  value: unknown,
  provider: SavedProvider,
  options?: { allowMissingApiKey?: boolean },
): AICharacterSettings {
  const input = object(value);
  const model = validateProviderModel(input.model, provider, options);
  const name = text(input.name, '玩家昵称', 24);
  if (!name) throw new AppError('请填写玩家昵称。');

  const inference = validateInferenceSettings(input, model, provider.type);
  const intervalMode = input.intervalMode ?? 'fixed';
  if (intervalMode !== 'fixed' && intervalMode !== 'random')
    throw new AppError('轮询方式无效。');
  const intervalMinMs = integer(
    input.intervalMinMs,
    '随机间隔下限',
    4000,
    1000,
    60000,
  );
  const intervalMaxMs = integer(
    input.intervalMaxMs,
    '随机间隔上限',
    8000,
    1000,
    60000,
  );
  if (intervalMinMs > intervalMaxMs)
    throw new AppError('随机间隔下限不能大于上限。');
  let capabilities;
  try {
    capabilities = validateCapabilities(input);
  } catch (error) {
    throw new AppError(
      error instanceof Error ? error.message : '角色能力无效。',
    );
  }
  return {
    ...capabilities,
    intervalMode,
    intervalMinMs,
    intervalMaxMs,
    providerId: provider.id,
    model,
    name,
    roleDescription: text(
      input.roleDescription,
      '角色设定',
      AI_CHARACTER_ROLE_DESCRIPTION_LIMIT,
    ),
    ...inference,
    taskLimitsEnabled: boolean(input.taskLimitsEnabled, true),
    maxTurns: integer(input.maxTurns, '任务调用上限', 100, 1, 1000),
    maxStalledTurns: integer(
      input.maxStalledTurns,
      '连续无进展上限',
      3,
      1,
      1000,
    ),
    tokenBudget: integer(
      input.tokenBudget,
      '任务 token 预算',
      50000,
      1000,
      100000000,
    ),
    taskTimeoutMs: integer(
      input.taskTimeoutMs,
      '任务时间上限',
      900000,
      1000,
      21600000,
    ),
    intervalMs: integer(input.intervalMs, '轮次间隔', 3000, 1000, 60000),
    voiceReplies: boolean(input.voiceReplies, false),
    voiceServiceId: text(
      input.voiceProviderId ?? input.voiceServiceId,
      '语音服务',
      80,
      input.voiceReplies ? 'local-default' : '',
    ),
  };
}

/** Public profile writes cannot create or replace task execution. */
export function aiCharacterProfileInput(value: unknown) {
  const input = object(value);
  if (
    input.startTask !== undefined ||
    input.taskTimeZone !== undefined ||
    input.goal !== undefined
  )
    throw new AppError(
      'Agent 配置不接受任务参数，请通过 Tasks 创建或修改任务。',
    );
  return input;
}

export function validateCapabilities(input: {
  permissions?: unknown;
  skills?: unknown;
}): { permissions: AICharacterPermissions; skills: AICharacterSkillId[] } {
  let permissions: AICharacterPermissions;
  if (input.permissions === undefined) {
    permissions = { move: true, chat: true, place: false, remove: false };
  } else {
    const value = input.permissions;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !AI_CHARACTER_PERMISSIONS.some((p) => p.id === key),
      ) ||
      AI_CHARACTER_PERMISSIONS.some(
        ({ id }) => typeof (value as Record<string, unknown>)[id] !== 'boolean',
      )
    ) {
      throw Error('动作权限格式无效，请完整配置四项权限。');
    }
    permissions = resolvePermissions(value as AICharacterPermissions);
  }
  const skills = input.skills === undefined ? [] : input.skills;
  if (
    !Array.isArray(skills) ||
    skills.some((id) => !AI_CHARACTER_SKILLS.some((skill) => skill.id === id))
  )
    throw Error('角色技能无效。');
  return {
    permissions,
    skills: AI_CHARACTER_SKILLS.filter(({ id }) => skills.includes(id)).map(
      ({ id }) => id,
    ),
  };
}
