import { DEFAULT_TASK_LIMITS, type TaskPlan } from '@voxel/shared';
import { testAgentConfig } from '../../../../tests/support/agent-config';
import type {
  CharacterRecord,
  ManagementArchive,
} from '../../src/persistence/archive';

export function storedPlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: 'plan',
    name: '巡查',
    goal: '检查世界',
    timing: { kind: 'immediate' },
    timeZone: 'Asia/Shanghai',
    limits: { ...DEFAULT_TASK_LIMITS },
    totalTokenBudget: 500000,
    state: 'enabled',
    reason: '',
    createdAt: 1793491200123,
    updatedAt: 1793491200456,
    spentTokens: 0,
    ...overrides,
  };
}

export function storedRun(
  overrides: Partial<ManagementArchive['runs'][number]> = {},
): ManagementArchive['runs'][number] {
  const { name, goal, timing, timeZone, limits, totalTokenBudget } =
    storedPlan();
  return {
    id: 'run',
    source: 'manual',
    scheduledAt: 1793491200789,
    snapshot: { name, goal, timing, timeZone, limits, totalTokenBudget },
    status: 'queued',
    reason: '',
    totalTokens: 0,
    accountedTokens: 0,
    logs: [],
    ...overrides,
  };
}

export function storedCharacter(
  overrides: Partial<CharacterRecord> = {},
): CharacterRecord {
  const { apiKey: _apiKey, ...config } = testAgentConfig();
  return {
    ...config,
    id: 'actor',
    providerId: 'deepseek',
    status: 'stopped',
    createdAt: 1793491200123,
    logEntries: [],
    ...overrides,
  };
}
