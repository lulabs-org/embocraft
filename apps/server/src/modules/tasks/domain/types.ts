import type { AgentRunState } from '@voxel/agent-runtime';
import type { TaskRun } from '@voxel/shared';

/**
 * 运行时任务运行快照及上下文
 */
export type StoredRun = TaskRun & {
  runtime?: AgentRunState;
  accountedTokens: number;
  requestId?: string;
  lastBatch?: string;
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
