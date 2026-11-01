import type { AICharacterTask, WorldEvent } from '@voxel/shared';
import { actionWakeDelay } from '../agent/action/runtime';
import { defaultEndpoint } from '../agent/model/pi';
import { nextIntervalMs } from '../agent/schedule';
import { TaskService } from '../agent/task/service';
import { AgentRunner } from '../agent/turn/wake';
import type { AgentConfig } from '../contracts/config';
import { AgentRuntimeError } from '../contracts/errors';
import type { TaskAuthority, TaskCommand } from '../contracts/task';
import { mergeSignals } from '../kernel/abort';
import { AgentAttention } from '../world/observe/attention';
import type { AgentSession } from '../world/session/port';
import { RuntimeExecution } from './execution';
import type {
  RuntimeOptions,
  RuntimeReceiveOptions,
  RuntimeRunOptions,
} from './ports';
import { receiveWorldEvent } from './receive';

export type { RuntimeRunOptions, RuntimeStore } from './ports';

/** Host facade: one state owner, input queue and execution slot per character. */
export class AgentRuntime extends RuntimeExecution {
  private messages: AgentAttention;
  private session?: AgentSession;
  private selfId: string;
  private connection = 0;
  private active?: { controller: AbortController; settled: Promise<void> };

  constructor(private readonly ports: RuntimeOptions = {}) {
    super(ports.state);
    this.messages = new AgentAttention();
    this.session = ports.session;
    this.selfId = ports.selfId ?? '';
  }

  protected override assertIdle() {
    if (this.active) throw new AgentRuntimeError('Agent 已在运行。', true);
  }

  get pendingMessages(): boolean {
    return this.messages.pending;
  }
  clearMessages() {
    this.messages.clear();
  }

  connect(session: AgentSession, selfId: string) {
    this.session = session;
    this.selfId = selfId;
    this.messages = new AgentAttention();
    this.connection++;
  }

  disconnect() {
    this.session = undefined;
    this.connection++;
    this.active?.controller.abort();
  }

  receive(event: WorldEvent, options: RuntimeReceiveOptions = {}) {
    const connection = this.connection;
    return receiveWorldEvent({
      state: () => this.memory,
      attention: () => this.messages,
      session: this.session,
      selfId: this.selfId,
      event,
      options: {
        ...options,
        save: options.save ?? (() => this.ports.store?.save()),
        isCurrent: () =>
          connection === this.connection && (options.isCurrent?.() ?? true),
      },
    });
  }

  async interrupt() {
    this.clearMessages();
    const active = this.active;
    active?.controller.abort();
    await active?.settled;
  }

  /** Standalone durable control. Joint host transactions use stageControl after stopping. */
  async control(
    command: TaskCommand,
    authority: TaskAuthority,
    config: AgentConfig,
  ): Promise<AICharacterTask> {
    // Reject unauthorized controls before allowing them to interrupt current work.
    new TaskService(this.snapshot()).command(command, authority, config);
    await this.interrupt();
    return new TaskService(this.memory).commit(command, authority, config, () =>
      Promise.resolve(this.ports.store?.save()),
    );
  }

  /** One serialized wake using the selected model transport. */
  async run(config: AgentConfig, options: RuntimeRunOptions): Promise<void> {
    if (this.active) throw new AgentRuntimeError('Agent 已在运行。', true);
    if (!this.session) throw new AgentRuntimeError('角色尚未连接世界。', true);
    const controller = new AbortController();
    let settle!: () => void;
    this.active = {
      controller,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    try {
      const runner = new AgentRunner(
        options.model?.endpoint ?? this.ports.endpoint ?? defaultEndpoint,
        options.model?.request ?? this.ports.request ?? fetch,
      );
      await runner.run({
        session: this.session,
        config,
        defaults: options.defaults,
        signal: mergeSignals(options.signal, controller.signal),
        memory: this.memory,
        attention: this.messages,
        log: options.log ?? this.ports.log,
        checkpoint:
          options.checkpoint ??
          (this.ports.store ? () => this.ports.store!.save() : undefined),
        hooks: options.hooks,
      });
    } finally {
      this.active = undefined;
      settle();
    }
  }

  /** Host scheduling reads policy, never follow/checkpoint internals. */
  nextWakeDelay(config: AgentConfig): number | undefined {
    if (this.pendingMessages) return 0;
    const view = this.view();
    if (view.active)
      return actionWakeDelay(this.memory) ?? nextIntervalMs(config);
    return undefined;
  }

  /** CLI keeps its original waiting-only scheduling and initial-goal behavior. */
  async runUntilSettled(config: AgentConfig, signal: AbortSignal) {
    if (config.goal) this.ensureTask(config.goal);
    do {
      if (signal.aborted) break;
      await this.run(config, { signal });
      const view = this.view();
      if (
        signal.aborted ||
        (!this.pendingMessages && view.task?.status !== 'waiting')
      )
        break;
      await this.messages.wait(
        actionWakeDelay(this.memory) ?? nextIntervalMs(config),
        signal,
      );
    } while (!signal.aborted);
  }
}

export function createAgentRuntime(ports: RuntimeOptions = {}): AgentRuntime {
  return new AgentRuntime(ports);
}
