import type { AgentConfig } from '../../contracts/config';
import type { RuntimeState } from '../../contracts/state';
import type { AgentAttention } from '../../world/observe/attention';
import type { AgentSession } from '../../world/session/port';

export type ActionStep = 'idle' | 'resume' | 'stop';

/** Host dependencies for advancing persisted actions, independent of a model turn. */
export type ActionRunOptions = {
  memory: RuntimeState;
  session: AgentSession;
  signal: AbortSignal;
  config: AgentConfig;
  attention?: AgentAttention;
  checkpoint?: () => void | Promise<void>;
};

export type ContinuingAction = {
  pending(memory: RuntimeState): boolean;
  wakeDelayMs: number;
  advance(options: ActionRunOptions): Promise<ActionStep>;
};
