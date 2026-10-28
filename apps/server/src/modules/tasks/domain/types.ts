import type { AgentRunState } from '@voxel/agent-runtime';
import type { TaskPlan, TaskRun } from '@voxel/shared';

/**
 * 运行时任务运行快照及上下文
 */
export type StoredRun = TaskRun & {
  runtime?: AgentRunState;
  accountedTokens: number;
  requestId?: string;
  lastBatch?: string;
};

/**
 * 任务持久化存档模型
 */
export type TaskBook = {
  version: 1;
  plans: TaskPlan[];
  runs: StoredRun[];
  currentRunId?: string;
  requests?: Record<string, string>;
};

export type { PlanQueryFilter } from '@voxel/shared/management';

/**
 * 任务运行历史分页列表响应结构
 */
export interface TaskRunsPage {
  items: TaskRun[];
  active: TaskRun[];
  total: number;
  nextOffset?: number;
}
