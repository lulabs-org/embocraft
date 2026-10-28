import type { AgentConfig } from '@voxel/agent-runtime';
import { parseArgs } from 'node:util';

export function agentConfig(
  options: Record<string, string | undefined> = cliOptions(),
): AgentConfig {
  const apiKey = options['api-key']?.trim();
  if (!apiKey)
    throw Error(
      '请通过 --api-key 提供 CLI 模型 API 密钥，或在 Web 控制台管理 Agent。',
    );
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(options[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max)
      throw Error(`${key} 必须是 ${min}–${max} 之间的整数。`);
    return value;
  };
  if (
    options['allow-edits'] &&
    !['true', 'false'].includes(options['allow-edits'])
  )
    throw Error('allow-edits 仅支持 true 或 false。');
  const intervalMode = options['interval-mode'] ?? 'fixed';
  if (intervalMode !== 'fixed' && intervalMode !== 'random')
    throw Error('interval-mode 仅支持 fixed 或 random。');
  const intervalMinMs = integer('interval-min-ms', 4000, 1000, 60000);
  const intervalMaxMs = integer('interval-max-ms', 8000, 1000, 60000);
  if (intervalMinMs > intervalMaxMs) throw Error('随机间隔下限不能大于上限。');
  const thinking = options['thinking'] ?? 'disabled';
  if (thinking !== 'enabled' && thinking !== 'disabled')
    throw Error('thinking 仅支持 enabled 或 disabled。');
  const reasoningEffort = options['reasoning-effort'] ?? 'high';
  if (!['none', 'low', 'high', 'max'].includes(reasoningEffort))
    throw Error('reasoning-effort 仅支持 none、low、high 或 max。');
  const model = options['model']?.trim() || 'deepseek-flash';
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(model)) throw Error('model 格式无效。');
  const goal =
    options['goal']?.trim() ||
    '探索附近环境，用中文简短介绍你的观察，友好回应附近玩家，不要反复发送相同消息。';
  if (goal.length > 2000) throw Error('goal 最多 2000 字。');
  const defaultMaxTokens = thinking === 'enabled' ? 4096 : 512;
  const maxTokens = integer('max-tokens', defaultMaxTokens, 128, 16384);
  const timeoutMs = integer('timeout-ms', 30000, 1000, 120000);

  return {
    apiKey,
    intervalMode,
    intervalMinMs,
    intervalMaxMs,
    thinking,
    reasoningEffort: reasoningEffort as AgentConfig['reasoningEffort'],
    maxTokens,
    model,
    goal,
    name: (options['name']?.trim() || 'DeepSeek · AI').slice(0, 24),
    allowEdits: options['allow-edits'] === 'true',
    voiceReplies: options['voice-replies'] === 'true',
    maxTurns: integer('max-turns', 100, 1, 1000),
    tokenBudget: integer('token-budget', 50000, 1000, 100000000),
    taskTimeoutMs: integer('task-timeout-ms', 900000, 1000, 21600000),
    intervalMs: integer('interval-ms', 3000, 1000, 60000),
    timeoutMs,
  };
}

function cliOptions(): Record<string, string | undefined> {
  return parseArgs({
    options: Object.fromEntries(
      [
        'allow-edits',
        'api-key',
        'goal',
        'interval-max-ms',
        'interval-min-ms',
        'interval-mode',
        'interval-ms',
        'max-tokens',
        'max-turns',
        'model',
        'name',
        'reasoning-effort',
        'task-timeout-ms',
        'thinking',
        'timeout-ms',
        'token-budget',
        'voice-replies',
      ].map((name) => [name, { type: 'string' as const }]),
    ),
  }).values;
}
