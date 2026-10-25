import type { WorldEvent } from '@voxel/shared';
import type { AgentConfig } from '../../contracts/config';
import type { DecisionContext } from '../../contracts/observation';
import type { AgentRunState } from '../../contracts/state';
import type { ToolState } from '../../contracts/tool-state';
import type { AgentAttention } from '../../world/observe/attention';
import type { AgentSession } from '../../world/session/port';
import type { RequestBudget } from '../task/budget';
import type { TaskCommand, TaskService } from '../task/service';

/**
 * Everything a tool handler may touch. Implemented by the turn and by test
 * doubles; tools never import the turn implementation, never mutate host
 * configuration, and move the turn only through the explicit commands below.
 */
export interface ToolHost {
  readonly session: AgentSession;
  readonly service: TaskService;
  readonly budget: RequestBudget;
  readonly state: ToolState;
  readonly activeSignal: AbortSignal;
  readonly memory: AgentRunState;
  /** Effective configuration for this turn; only the host may switch it. */
  readonly config: AgentConfig;
  readonly message?: WorldEvent;
  readonly attention?: AgentAttention;
  readonly log?: (message: string) => void;

  prepared(): DecisionContext;
  observe(): Promise<void>;
  save(): Promise<void>;
  authorize(): void;
  attach(): void;

  /** Answers the addressed message, attaching the active task when asked. */
  respond(text: string, relatedToTask?: boolean): Promise<void>;
  /** Commits a player task command and resets this turn's task-bound state. */
  commitTask(command: TaskCommand, reply?: string): Promise<void>;

  /** A background action or an already started action owns the world write slot. */
  actionBusy(): boolean;
  launch(id: string, controller: AbortController, work: Promise<void>): void;
}
