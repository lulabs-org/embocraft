import type { AgentSession } from '../world/session/port';
import type { AgentAttention } from '../world/observe/attention';
import type { AgentConfig, ModelEndpoint } from '../contracts/config';
import type { AgentRunState } from '../contracts/state';
import type { RunOptions } from '../agent/turn/turn';
import type { WorldEvent } from '@voxel/shared';
import type { TaskLease } from '../contracts/task';

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
  runner?: RuntimeRunner;
};

/** Offline state/ledger operations may be constructed before a world connection exists. */
export type RuntimeOptions = Omit<RuntimePorts, 'session' | 'selfId'> &
  Partial<Pick<RuntimePorts, 'session' | 'selfId'>>;

export type RuntimeRunner = { run(options: RunOptions): Promise<void> };

export type RuntimeMessageControl = {
  operation: 'pause' | 'cancel';
  lease: TaskLease;
  commandId: string;
  message: WorldEvent;
};

export type RuntimeReceiveOptions = {
  save?: () => Promise<void> | void;
  /** The host may have closed or replaced the connection during persistence. */
  isCurrent?: () => boolean;
  onOverflow?: () => Promise<void> | void;
  control?: (command: RuntimeMessageControl) => Promise<unknown>;
  controlCommitted?: () => void;
  replyToControl?: boolean;
};

export type RuntimeReceiveResult =
  | 'ignored'
  | 'queued'
  | 'full'
  | 'stale'
  | 'controlled';

export type RuntimeRunOptions = {
  defaults?: AgentConfig;
  signal: AbortSignal;
  checkpoint?: () => void | Promise<void>;
  hooks?: RunOptions['hooks'];
  runner?: RuntimeRunner;
  log?: (message: string) => void;
};
