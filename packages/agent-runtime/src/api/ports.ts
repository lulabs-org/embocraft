import type { AgentSession } from '../world/session/port';
import type { AgentAttention } from '../world/observe/attention';
import type { AgentConfig, ModelEndpoint } from '../contracts/config';
import type { AgentRunState } from '../contracts/state';
import type { RunOptions } from '../agent/turn/turn';

/** Persistence seam: the host decides how state is stored, the facade only commits. */
export type RuntimeStore = { save(): Promise<void> | void };

export type RuntimePorts = {
  session: AgentSession;
  /** Session id used to filter addressed chat. */
  selfId: string;
  endpoint?: ModelEndpoint;
  request?: typeof fetch;
  log?: (message: string) => void;
  store?: RuntimeStore;
  attention?: AgentAttention;
  state?: AgentRunState;
};

export type RuntimeRunOptions = {
  defaults?: AgentConfig;
  signal: AbortSignal;
  checkpoint?: () => void | Promise<void>;
  hooks?: RunOptions['hooks'];
};
