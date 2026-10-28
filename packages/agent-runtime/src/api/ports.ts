import type { AICharacterTask, WorldEvent } from '@voxel/shared';
import type { AgentConfig, ModelEndpoint } from '../contracts/config';
import type { RuntimeState } from '../contracts/state';
import type { TaskLease } from '../contracts/task';
import type { AgentSession } from '../world/session/port';

/** Persistence seam: the host decides how state is stored, the facade only commits. */
export type RuntimeStore = { save(): Promise<void> | void };

export type RuntimeModelOptions = {
  endpoint?: ModelEndpoint;
  request?: typeof fetch;
};

export type RuntimeOptions = RuntimeModelOptions & {
  session?: AgentSession;
  /** Session id used to filter addressed chat. */
  selfId?: string;
  log?: (message: string) => void;
  store?: RuntimeStore;
  state?: RuntimeState;
};

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
  hooks?: {
    beforeNewTask?: (
      task: AICharacterTask,
      previous: RuntimeState,
    ) => Promise<void>;
  };
  model?: RuntimeModelOptions;
  log?: (message: string) => void;
};
