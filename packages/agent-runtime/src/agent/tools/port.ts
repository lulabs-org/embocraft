import type { AICharacterTask } from '@voxel/shared';
import type { AgentAction } from '../../contracts/action';
import type { DecisionContext, Observation } from '../../contracts/observation';
import type { TaskCommand } from '../../contracts/task';

export type ToolTaskOutcome =
  | { status: 'completed' | 'blocked' | 'needs_input'; reason: string }
  | { status: 'waiting'; waitFor: 'world' | 'players'; reason: string };

/**
 * High-level host operations available to model tool handlers.
 * Tools never access the world session, task lease, or persistence internals directly.
 */
export interface ToolHost {
  /** Refreshes the world observation and returns the audience-filtered decision view. */
  observeWorld(): Promise<{
    observation: Observation;
    activity: DecisionContext['context'];
  }>;

  /** Answers an addressed player message, attaching the active task when asked. */
  respond(text: string, relatedToTask?: boolean): Promise<void>;

  /** Authorizes and commits a player task command, optionally replying in chat. */
  commitTask(command: TaskCommand, reply?: string): Promise<AICharacterTask>;

  /** Settles the active task's status, optionally asking a follow-up question in chat. */
  settleTask(
    outcome: ToolTaskOutcome,
    questionToAsk?: string,
  ): Promise<{ status: AICharacterTask['status']; summary: string }>;

  /** Executes a synchronous world action or launches a background world action. */
  executeWorldAction(
    id: string,
    action: AgentAction,
    relatedToTask?: boolean,
  ): Promise<unknown>;
}
