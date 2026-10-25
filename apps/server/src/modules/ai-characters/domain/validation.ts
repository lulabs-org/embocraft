import {
  AI_CHARACTER_ROLE_DESCRIPTION_LIMIT,
  type AICharacterSettings,
  AI_CHARACTER_PERMISSIONS,
  AI_CHARACTER_SKILLS,
  resolvePermissions,
  type AICharacterPermissions,
  type AICharacterSkillId,
  type ProviderType,
} from '@voxel/shared';
import { AppError } from '../../../common/errors';
import { object, text, integer, boolean } from '../../../common/validation';
import { type SavedProvider } from '../../providers/provider-validation';

const ALLOWED_REASONING_EFFORTS = ['none', 'low', 'high', 'max'] as const;

export function resolveInferenceDefaults(
  model: string,
  providerType: ProviderType,
): {
  timeoutMs: number;
  maxTokens: number;
  thinking: 'enabled' | 'disabled';
  reasoningEffort: 'none' | 'low' | 'high' | 'max';
} {
  const isReasoning = /(reasoner|r1|^o[134])/i.test(model);
  const thinking = isReasoning ? 'enabled' : 'disabled';
  return {
    thinking,
    reasoningEffort: 'high',
    timeoutMs: providerType === 'ollama' ? 120000 : 60000,
    maxTokens: thinking === 'enabled' ? 4096 : 512,
  };
}

export function validateAICharacter(
  value: unknown,
  provider: SavedProvider,
): AICharacterSettings {
  const input = object(value);
  const model = text(input.model, '模型', 128, provider.defaultModel);
  if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(model))
    throw new AppError('请输入有效模型 ID。');
  if (provider.type === 'ollama' && /cloud/i.test(model))
    throw new AppError('Ollama 请选择已安装在目标服务上的模型。');
  if (provider.type !== 'ollama' && !provider.apiKey)
    throw new AppError('请先为该模型服务配置 API Key。');
  const name = text(input.name, '玩家昵称', 24);
  const goal = text(input.goal, '任务目标', 2000);
  if (!name) throw new AppError('请填写玩家昵称。');

  const defaults = resolveInferenceDefaults(model, provider.type);
  const thinking = input.thinking ?? defaults.thinking;
  const reasoningEffort = input.reasoningEffort ?? defaults.reasoningEffort;

  if (thinking !== 'enabled' && thinking !== 'disabled') {
    throw new AppError('思考模式无效。');
  }
  if (
    typeof reasoningEffort !== 'string' ||
    !ALLOWED_REASONING_EFFORTS.includes(
      reasoningEffort as (typeof ALLOWED_REASONING_EFFORTS)[number],
    )
  ) {
    throw new AppError('推理强度无效。');
  }
  if (provider.type !== 'deepseek' && thinking !== 'disabled') {
    throw new AppError('此模型服务暂不提供 DeepSeek 思考参数。');
  }

  const timeoutMs = integer(input.timeoutMs, '推理超时', defaults.timeoutMs, 1000, 120000);
  const maxTokens = integer(
    input.maxTokens,
    '输出长度',
    thinking === 'enabled' ? 4096 : defaults.maxTokens,
    128,
    16384,
  );
  const inference = {
    thinking: thinking as AICharacterSettings['thinking'],
    reasoningEffort: reasoningEffort as AICharacterSettings['reasoningEffort'],
    timeoutMs,
    maxTokens,
  };
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
    continuous: boolean(input.continuous, false),
    intervalMode,
    intervalMinMs,
    intervalMaxMs,
    providerId: provider.id,
    model,
    name,
    goal,
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
    allowEdits:
      capabilities.permissions.place && capabilities.permissions.remove,
    voiceReplies: boolean(input.voiceReplies, false),
    voiceServiceId: text(
      input.voiceServiceId,
      '语音服务',
      80,
      input.voiceReplies ? 'local-default' : '',
    ),
  };
}

/** Public profile writes cannot create or replace task execution. Empty legacy goals are harmless. */
export function aiCharacterProfileInput(value: unknown) {
  const input = object(value);
  if (
    input.startTask !== undefined ||
    input.taskTimeZone !== undefined ||
    (input.goal !== undefined && input.goal !== '')
  )
    throw new AppError(
      'Agent 配置不接受任务参数，请通过 Tasks 创建或修改任务。',
    );
  return input;
}

export function validateCapabilities(input: {
  permissions?: unknown;
  skills?: unknown;
  allowEdits?: unknown;
}): { permissions: AICharacterPermissions; skills: AICharacterSkillId[] } {
  let permissions: AICharacterPermissions;
  if (input.permissions === undefined) {
    if (input.allowEdits !== undefined && typeof input.allowEdits !== 'boolean')
      throw Error('建造权限格式无效。');
    permissions = resolvePermissions(input.allowEdits === true);
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
