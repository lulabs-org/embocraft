import type { AgentRuntime, RuntimeState } from '@voxel/agent-runtime';
import type { AICharacterSettings, AICharacterView } from '@voxel/shared';
import type { PlanQueryFilter } from './domain/types';
import type { PlanService } from './persistence/plan-store';

/**
 * Tasks / Plans 领域的管理接口契约（由 TaskCoordinator 实现）
 */
export interface TaskPort {
  planPage(params: PlanQueryFilter): unknown;
  publicPlans(characterId?: string, metadata?: boolean): unknown;
  publicPlan(planId: string): unknown;
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
  ): unknown;
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
  readonly ledger: PlanService;
  currentRunId: string | undefined;
  taskMutating?: boolean;
  readonly updating?: boolean;
  readonly controlling?: boolean;
  readonly storageFailed?: boolean;
  readonly online: boolean;
}

/** Tasks owns policy; the Agent adapter owns runtime effects and serialization with shutdown. */
export interface TaskHostPort {
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
  ): AICharacterSettings;
  storageFailed(): boolean;
  committedName(id: string): string | undefined;
  publicIdentity(id: string): RuntimeState['execution']['task']['identity'];
  resourceVersion(): number;
  isClosing(): boolean;
  assertWritable(id?: string): void;
}
