// 1. 契约与业务服务
export type { TaskPort } from './ports';
export {
  bindTaskService,
  getActiveTaskService,
} from './services/task-runtime.service';

// 2. HTTP 路由
export { createTaskRouter } from './routes/tasks.routes';

// 3. 仓储与内存存储服务
export { TaskPlanService } from './services/plan.service';
export { restoreTaskExecution, restoreTaskMemory } from './persistence/restore';
export { TaskSnapshots } from './persistence/snapshots';

// 4. 定时调度器
export { TaskScheduler } from './services/scheduler.service';

// 5. 模型工厂与领域状态计算
export {
  endedRun,
  runView,
  planDraft,
  newPlan,
  newRun,
  duePlans,
  settleTaskUsage,
  syncPlanStateFromRun,
} from './domain/model';
export { nextOccurrence } from './domain/timing';

// 6. 输入校验
export { validatePlan } from './domain/validation';

// 7. 领域与 DTO 类型
export type { StoredRun, PlanQueryFilter, TaskRunsPage } from './domain/types';

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
