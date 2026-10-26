import type { AICharacterTask, WorldEvent } from '@voxel/shared';
import type { ModelEndpoint } from '../contracts/config';
import { AgentRuntimeError } from '../contracts/errors';
import type { AgentConfig } from '../contracts/config';
import { emptyState, type AgentRunState } from '../contracts/state';
import { defaultEndpoint } from '../agent/model/pi';
import { recordChatEvent } from '../agent/task/inbox';
import {
  TaskService,
  type TaskAuthority,
  type TaskCommand,
} from '../agent/task/service';
import { CharacterRunner } from '../agent/turn/wake';
import type { RunOptions } from '../agent/turn/turn';
import { AgentAttention } from '../world/observe/attention';
import type { RuntimePorts, RuntimeRunOptions } from './ports';

export type { RuntimePorts, RuntimeRunOptions, RuntimeStore } from './ports';
export type { RunOptions } from '../agent/turn/turn';

const running = new WeakSet<AgentRunState>();
/** Stable host entrypoint; one serialized execution slot per Agent, shared across host wake-ups. */
export class AgentRunner {
  constructor(
    private endpoint: ModelEndpoint = defaultEndpoint,
    private request: typeof fetch = fetch,
  ) {}
  async run(options: RunOptions): Promise<void> {
    if (running.has(options.memory))
      throw new AgentRuntimeError('Agent 已在运行。', true);
    running.add(options.memory);
    try {
      options.signal.throwIfAborted();
      await new CharacterRunner(this.endpoint, this.request).run(options);
    } finally {
      running.delete(options.memory);
    }
  }
}

/**
 * Host facade: owns the event queue, the state projection and the single
 * execution slot. Callers submit world events and control commands; they never
 * build event ids, parse control words or mutate state sections themselves.
 */
export class AgentRuntime {
  readonly state: AgentRunState;
  readonly attention: AgentAttention;
  private readonly session: RuntimePorts['session'];
  private readonly selfId: string;
  private readonly endpoint: ModelEndpoint;
  private readonly request: typeof fetch;
  private readonly log?: (message: string) => void;
  private readonly store?: RuntimePorts['store'];

  constructor(ports: RuntimePorts) {
    this.session = ports.session;
    this.selfId = ports.selfId;
    this.endpoint = ports.endpoint ?? defaultEndpoint;
    this.request = ports.request ?? fetch;
    this.log = ports.log;
    this.store = ports.store;
    this.state = ports.state ?? emptyState();
    this.attention = ports.attention ?? new AgentAttention();
  }

  /** Record, persist and queue one addressed chat event. Duplicates are rejected. */
  async submit(event: WorldEvent): Promise<boolean> {
    if (!this.attention.accept(event, this.selfId)) return false;
    const envelope = recordChatEvent(
      this.state,
      event,
      this.attention.generation,
    );
    await this.store?.save();
    if (!this.attention.enqueue(event)) {
      envelope.state = 'unknown';
      await this.store?.save();
      return false;
    }
    return true;
  }

  /** Authorized task command; persistence and rollout go through the task service. */
  async control(
    command: TaskCommand,
    authority: TaskAuthority,
    config: AgentConfig,
  ): Promise<AICharacterTask> {
    return new TaskService(this.state).commit(command, authority, config, () =>
      Promise.resolve(this.store?.save()),
    );
  }

  /** One wake-up through the shared execution slot. */
  async run(config: AgentConfig, options: RuntimeRunOptions): Promise<void> {
    await new AgentRunner(this.endpoint, this.request).run({
      session: this.session,
      config,
      defaults: options.defaults,
      signal: options.signal,
      memory: this.state,
      attention: this.attention,
      log: this.log,
      checkpoint:
        options.checkpoint ??
        (this.store ? () => this.store!.save() : undefined),
      hooks: options.hooks,
    });
  }

  /** Read-only projection for archives and consoles. */
  snapshot(): AgentRunState {
    return structuredClone(this.state);
  }
}

export function createAgentRuntime(ports: RuntimePorts): AgentRuntime {
  return new AgentRuntime(ports);
}
