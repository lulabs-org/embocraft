// 1. 契约与业务服务
export type { TaskPort } from './ports';

// 2. HTTP 路由
export { taskCommandBody } from './domain/command-policy';
export { installTaskRoutes } from './routes/tasks.routes';

// 3. 仓储与内存存储服务
export {
  migrateBinding,
  migrateCharacterTasks,
} from './persistence/archive-migration';
export { PlanService, TaskPlanService } from './persistence/plan-store';
export { restoreTaskExecution, restoreTaskMemory } from './persistence/restore';
export { TaskSnapshots } from './persistence/snapshots';

// 4. 定时调度器
export { TaskScheduler } from './services/scheduler.service';

// 5. 模型工厂与领域状态计算
export {
  duePlans,
  endedRun,
  newPlan,
  newRun,
  nextOccurrence,
  planDraft,
  runView,
  settleTaskUsage,
  syncPlanStateFromRun,
  wallClockInstant,
} from './domain/model';

// 6. 输入校验
export { validatePlan } from './domain/validation';

// 7. 领域与 DTO 类型
export type {
  PlanQueryFilter,
  StoredRun,
  TaskBook,
  TaskRunsPage,
} from './domain/types';

export type { TaskExecutionState, TaskHostPort } from './ports';
export { TaskCoordinator } from './services/coordinator.service';
export {
  beginChatExecution,
  captureTask,
  currentRun,
  executionConfigOverrides,
  markJoined,
  markOffline,
  modelChanged,
  pauseTaskForHost,
} from './services/execution.service';
