import type { AgentRuntime, RuntimeState } from '@voxel/agent-runtime';
import type {
  AICharacterSettings,
  AICharacterView,
  TaskPlan,
  TaskPlanSummary,
  TaskRun,
} from '@voxel/shared';
import type { PlanQueryFilter } from './domain/types';
import type { TaskPlanService } from './services/plan.service';

export type TaskQueryResult<T> = {
  value: T;
  taskIdentity: NonNullable<
    RuntimeState['execution']['task']['identity']
  > | null;
};

export type TaskPlanResult = TaskQueryResult<TaskPlan> & {
  characterName?: string;
};
export type TaskRunPageResult = {
  items: TaskQueryResult<TaskRun>[];
  active: TaskQueryResult<TaskRun>[];
  total: number;
  nextOffset?: number;
};

export interface TaskQueryPort {
  plans(
    characterId?: string,
    requireCharacter?: boolean,
  ): Promise<TaskPlanResult[]>;
  plan(id: string): Promise<TaskPlanResult>;
  planPage(
    filter: PlanQueryFilter,
  ): Promise<{ items: TaskPlanSummary[]; total: number; nextOffset?: number }>;
  runs(
    planId: string,
    offset?: number,
    characterId?: string,
    requireCharacter?: boolean,
  ): Promise<TaskRunPageResult>;
}

/**
 * Tasks / Plans 领域的管理接口契约（由 TaskCoordinator 实现）
 */
export interface TaskPort {
  planPage(params: PlanQueryFilter): Promise<unknown>;
  publicPlans(characterId?: string, metadata?: boolean): Promise<unknown>;
  publicPlan(planId: string): Promise<unknown>;
  createTaskPlan(characterId: string, value: unknown): Promise<unknown>;
  updateTaskPlan(
    characterId: string | undefined,
    planId: string,
    value: unknown,
  ): Promise<unknown>;
  controlTaskPlan(
    characterId: string | undefined,
    planId: string,
    operation: string,
    value: unknown,
  ): Promise<unknown>;
  reassignPlan(
    planId: string,
    targetCharacterId: string,
    value?: unknown,
  ): Promise<unknown>;
  publicRuns(
    characterId: string | undefined,
    planId: string,
    offset?: number,
    metadata?: boolean,
  ): Promise<unknown>;
  controlTaskRun(
    characterId: string | undefined,
    runId: string,
    operation: string,
    value: unknown,
  ): Promise<unknown>;
}

/** Mutable task state only: no world Session, runner, abort controller or Agent registry. */
export interface TaskExecutionState {
  view: AICharacterSettings &
    Pick<AICharacterView, 'id' | 'status' | 'logEntries'>;
  readonly runtime: AgentRuntime;
  readonly ledger: TaskPlanService;
  currentRunId: string | undefined;
  taskMutating?: boolean;
  readonly updating?: boolean;
  readonly controlling?: boolean;
  readonly storageFailed?: boolean;
  readonly online: boolean;
}

/** Tasks owns policy; the Agent adapter owns runtime effects and serialization with shutdown. */
export interface TaskHostPort {
  withExecution?<T>(id: string, action: () => Promise<T>): Promise<T>;
  readCharacter?(id: string): Promise<AICharacterSettings & { id: string }>;
  execution(id: string): TaskExecutionState;
  findExecution(id: string): TaskExecutionState | undefined;
  executions(): Iterable<TaskExecutionState>;
  save(): Promise<void>;
  schedule(id: string): void;
  launch(id: string): void;
  withStoppedExecution<T>(id: string, change: () => Promise<T>): Promise<T>;
  validateExecution(
    id: string,
    settings: Partial<AICharacterSettings>,
  ): AICharacterSettings | Promise<AICharacterSettings>;
  storageFailed(): boolean;
  committedName(id: string): string | undefined;
  publicIdentity(id: string): RuntimeState['execution']['task']['identity'];
  resourceVersion(): number;
  isClosing(): boolean;
  assertWritable(id?: string): void;
}
