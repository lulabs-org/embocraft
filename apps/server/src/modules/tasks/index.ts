// 1. 契约与业务服务
export type { TaskPort } from './ports';

// 2. HTTP 路由
export { installTaskRoutes } from './routes/tasks.routes';
export { taskCommandBody } from './domain/command-policy';

// 3. 仓储与内存存储服务
export { TaskPlanService, PlanService } from './persistence/plan-store';
export { restoreTaskExecution, restoreTaskMemory } from './persistence/restore';
export { TaskSnapshots } from './persistence/snapshots';
export {
  migrateBinding,
  migrateCharacterTasks,
} from './persistence/archive-migration';

// 4. 定时调度器
export { TaskScheduler } from './services/scheduler.service';

// 5. 模型工厂与领域状态计算
export {
  emptyTaskBook,
  endedRun,
  runView,
  planDraft,
  newPlan,
  newRun,
  duePlans,
  wallClockInstant,
  nextOccurrence,
  settleTaskUsage,
  syncPlanStateFromRun,
} from './domain/model';

// 6. 输入校验
export { validatePlan } from './domain/validation';

// 7. 领域与 DTO 类型
export type {
  StoredRun,
  TaskBook,
  PlanQueryFilter,
  PlanControlOperation,
  RunControlOperation,
  TaskRunsPage,
} from './domain/types';

export { TaskCoordinator } from './services/coordinator.service';
export {
  beginChatExecution,
  captureTask,
  currentRun,
  executionConfigOverrides,
  pauseTaskForHost,
  markJoined,
  markOffline,
  modelChanged,
} from './services/execution.service';
export type { TaskExecutionState, TaskHostPort } from './ports';
