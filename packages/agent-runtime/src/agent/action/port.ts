import type { AgentConfig } from '../../contracts/config';
import type { AgentRunState } from '../../contracts/state';
import type { AgentSession } from '../../world/session/port';
import type { AgentAttention } from '../../world/observe/attention';

export type ActionStep = 'idle' | 'resume' | 'stop';

/** Host dependencies for advancing persisted actions, independent of a model turn. */
export type ActionRunOptions = {
  memory: AgentRunState;
  session: AgentSession;
  signal: AbortSignal;
  config: AgentConfig;
  attention?: AgentAttention;
  checkpoint?: () => void | Promise<void>;
};

export type ContinuingAction = {
  pending(memory: AgentRunState): boolean;
  wakeDelayMs: number;
  advance(options: ActionRunOptions): Promise<ActionStep>;
};
