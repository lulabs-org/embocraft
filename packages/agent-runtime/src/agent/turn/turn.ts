import type { Message } from '@earendil-works/pi-ai';
import {
  aiCharacterPermissions,
  type AICharacterTask,
  type ChatData,
  type WorldEvent,
} from '@voxel/shared';
import type { AgentConfig, ModelEndpoint } from '../../contracts/config';
import { AgentRuntimeError } from '../../contracts/errors';
import type { DecisionContext } from '../../contracts/observation';
import type { AgentRunState, CharacterEvent } from '../../contracts/state';
import { initialToolState, type ToolState } from '../../contracts/tool-state';
import { cancellable } from '../../kernel/abort';
import { worldSignature } from '../../world/observe/extract';
import type { AgentAttention } from '../../world/observe/attention';
import type { AgentSession } from '../../world/session/port';
import { paceChat } from '../action/chat-pacing';
import { characterPrompt } from '../prompt/system';
import { checkBudgetCap, RequestBudget } from '../task/budget';
import { recordChatEvent } from '../task/inbox';
import { TaskService, type TaskLease } from '../task/service';
import { createTaskControlTools } from '../tools/conversation';
import type { ToolHost } from '../tools/port';
import { createRuntimeWorldTools } from '../tools/world';
import { checkpointMessages, updateCheckpoint } from './checkpoint';
import { runDecisionLoop } from './decide';
import { TurnHealthMonitor } from './health';
import { buildDecisionPayload } from './input';
import type { RunOptions } from './options';
import { prepareDecision } from './prepare';
import { recentInteractions, recentTurns } from './window';

/** The single background-action slot a turn may launch into and stop. */
export type TurnActions = {
  running(): boolean;
  launch(id: string, controller: AbortController, work: Promise<void>): void;
  stop(): Promise<void>;
};

export type TurnDeps = {
  options: RunOptions;
  endpoint: ModelEndpoint;
  request: typeof fetch;
  message?: WorldEvent;
  actions: TurnActions;
};

/**
 * One decision flow for an addressed message, a plan instruction or an action
 * result. Owns the per-turn lease, budget, observation and launch flags so the
 * wake loop stays a loop and tools receive an explicit host port.
 */
export class Turn implements ToolHost {
  readonly session: AgentSession;
  readonly service: TaskService;
  readonly state: ToolState = initialToolState();
  readonly activeSignal: AbortSignal;
  readonly memory: AgentRunState;
  readonly config: AgentConfig;
  readonly userConfig: AgentConfig;
  readonly defaults: AgentConfig;
  readonly budget: RequestBudget;
  readonly message?: WorldEvent;
  readonly attention?: AgentAttention;
  readonly log?: (message: string) => void;
  readonly beforeNewTaskHook?: (
    task: AICharacterTask,
    previous: AgentRunState,
  ) => Promise<void>;

  private expected?: TaskLease;
  private event?: CharacterEvent;
  private preparedValue?: DecisionContext;
  private readonly scope: string;
  private attached: boolean;
  private launched = false;
  private runningAction: boolean;
  private readonly health = new TurnHealthMonitor();
  private readonly deps: TurnDeps;

  constructor(deps: TurnDeps) {
    this.deps = deps;
    const { options } = deps;
    const { memory } = options;
    this.session = options.session;
    this.activeSignal = options.signal;
    this.memory = memory;
    this.userConfig = options.config;
    this.defaults = options.defaults ?? options.config;
    this.message = deps.message;
    this.attention = options.attention;
    this.log = options.log;
    this.beforeNewTaskHook = options.hooks?.beforeNewTask;
    this.service = new TaskService(memory);
    this.expected = memory.task.current ? this.service.lease() : undefined;
    this.attached = !deps.message;
    this.runningAction = deps.actions.running();
    this.scope = deps.message
      ? (deps.message.data as ChatData).scope !== 'public'
        ? deps.message.actor
        : 'public'
      : (memory.task.current?.privateTo ?? 'public');

    const config = { ...(deps.message ? this.defaults : options.config) };
    if (deps.message) {
      if (!Number.isFinite(config.maxTurns)) config.maxTurns = 100;
      if (!Number.isFinite(config.tokenBudget)) config.tokenBudget = 50000;
      if (!Number.isFinite(config.taskTimeoutMs)) config.taskTimeoutMs = 900000;
    }
    this.config = config;
    memory.task.usage ??= { calls: 0, tokens: 0, estimated: false };
    this.budget = new RequestBudget(
      config,
      memory.task.usage,
      deps.message ? undefined : memory.task.current,
    );
  }

  get endpoint(): ModelEndpoint {
    return this.deps.endpoint;
  }

  get request(): typeof fetch {
    return this.deps.request;
  }

  private current() {
    return !this.expected || this.service.current(this.expected);
  }

  prepared(): DecisionContext {
    return this.preparedValue!;
  }

  async observe() {
    const next = await prepareDecision(
      this.session,
      this.memory,
      this.activeSignal,
      this.message,
    );
    if (next) this.preparedValue = next;
  }

  async save() {
    this.budget.flushTime();
    if (this.state.persistenceFailed)
      throw new AgentRuntimeError('无法保存事件检查点，已停止。', true);
    try {
      await this.deps.options.checkpoint?.();
    } catch {
      this.state.persistenceFailed = true;
      this.state.terminal = true;
      throw new AgentRuntimeError('无法保存事件检查点，已停止写操作。', true);
    }
  }

  authorize() {
    if (this.expected) this.service.assertCurrent(this.expected);
    if (this.message)
      this.service.authorize({ kind: 'player', message: this.message });
  }

  attach() {
    if (this.attached) return;
    this.authorize();
    const task = this.memory.task.current;
    if (!task || !['running', 'waiting'].includes(task.status))
      throw new AgentRuntimeError('当前任务未运行，请先恢复或创建任务。');
    Object.assign(this.config, this.userConfig);
    this.budget.attach(task);
    this.attached = true;
  }

  async send(text: string) {
    const { memory, activeSignal } = this;
    memory.health.lastResponse = text;
    if (!aiCharacterPermissions(this.config).chat) {
      this.log?.(text);
      await this.save();
      return;
    }
    await paceChat(memory, activeSignal);
    if (this.event) this.event.state = 'unknown';
    await this.save();
    const response = await cancellable(
      this.session.request('chat', {
        text,
        scope: this.scope === 'public' ? 'public' : 'private',
        recipients: this.scope === 'public' ? [] : [this.scope],
      }),
      activeSignal,
    );
    if (!response.ok)
      throw new AgentRuntimeError('回复未送达，本次不自动重发。');
    if (this.event) this.event.state = 'processing';
    await this.save();
  }

  actionRunning() {
    return this.runningAction;
  }

  isLaunched() {
    return this.launched;
  }

  onLaunched() {
    this.launched = true;
  }

  launch(id: string, controller: AbortController, work: Promise<void>) {
    this.deps.actions.launch(id, controller, work);
  }

  stopAction() {
    return this.deps.actions.stop();
  }

  onActionStopped() {
    this.runningAction = false;
    this.launched = false;
  }

  onTaskCommitted(lease: TaskLease) {
    this.expected = lease;
    this.attached = true;
  }

  /** Resolve the queued event, run one Pi decision loop and settle the event. */
  async run() {
    const { memory, activeSignal: signal } = this;
    if (!(await this.resolveEvent())) return;
    try {
      if (!this.message) {
        const reason = checkBudgetCap(memory.task.current!, this.config);
        if (reason) throw new AgentRuntimeError(reason);
      }
      this.preparedValue = await prepareDecision(
        this.session,
        memory,
        signal,
        this.message,
      );
      if (!this.preparedValue) return;
      memory.health.lastProgress ??=
        worldSignature(this.preparedValue.observation, 'world') +
        JSON.stringify(this.preparedValue.observation.self);

      const controlTools = createTaskControlTools(this);
      const worldTools = createRuntimeWorldTools(this);
      const history = this.message
        ? (memory.conversation.exchanges?.[this.scope] as Message[] | undefined)
        : checkpointMessages(memory);

      await runDecisionLoop({
        config: this.config,
        endpoint: this.deps.endpoint,
        request: this.deps.request,
        budget: this.budget,
        signal,
        state: this.state,
        sessionKey: this.session,
        interactionHistory: !!this.message,
        prompt: characterPrompt(this.config),
        tools: [...controlTools, ...worldTools],
        history,
        input: buildDecisionPayload({
          config: this.config,
          message: this.message,
          prepared: this.preparedValue,
          memory,
          event: this.event,
        }),
        save: () => this.save(),
        shouldYield: () =>
          !this.current() || (!this.message && !!this.attention?.pending),
        contextEpoch: () =>
          `${memory.task.identity?.id}:${memory.task.identity?.revision}`,
        afterTurn: () =>
          this.health.recordTurn({
            maxStalledTurns: this.config.maxStalledTurns,
            state: this.state,
            attached: this.attached,
            current: () => this.current(),
            memory,
            service: this.service,
            hasMessage: !!this.message,
            launched: this.launched,
            observation: this.preparedValue!.observation,
          }),
        transcript: async (messages) => {
          const clean = JSON.parse(
            JSON.stringify(
              (this.message ? recentInteractions : recentTurns)(messages),
            )
              .split(this.config.apiKey || '\u0000')
              .join('[已隐藏]'),
          );
          if (this.message) {
            memory.conversation.exchanges ??= {};
            delete memory.conversation.exchanges[this.scope];
            memory.conversation.exchanges[this.scope] = clean;
            const keys = Object.keys(memory.conversation.exchanges).filter(
              (key) => key !== 'public',
            );
            for (const key of keys.slice(0, -16))
              delete memory.conversation.exchanges[key];
          }
          if (this.attached && memory.task.current)
            updateCheckpoint(memory, clean, this.config.apiKey);
          await this.save();
        },
      });
      if (this.event && this.event.state !== 'unknown')
        this.event.state = 'done';
    } catch (error) {
      if (!signal.aborted) {
        const reason =
          error instanceof Error ? error.message : '角色事件处理失败。';
        memory.health.lastResponse = reason;
        this.log?.(reason);
        if (
          this.attached &&
          this.current() &&
          memory.task.current &&
          !['completed', 'cancelled'].includes(memory.task.current.status)
        ) {
          memory.task.current.status =
            checkBudgetCap(memory.task.current, this.config) || signal.aborted
              ? 'budget'
              : 'blocked';
          memory.task.current.reason = reason;
        }
      }
      if (this.event && this.event.state !== 'done')
        this.event.state = 'unknown';
      if (this.state.persistenceFailed) throw error;
    } finally {
      if (!this.state.persistenceFailed) await this.save();
    }
  }

  /** Returns false when the event belongs to another revision or was settled. */
  private async resolveEvent(): Promise<boolean> {
    const event: CharacterEvent | undefined = this.message
      ? recordChatEvent(this.memory, this.message, this.attention?.generation)
      : this.memory.inbox?.events.find(
          (e) =>
            e.state === 'pending' &&
            e.kind !== 'chat' &&
            (e.kind !== 'plan' || e.taskId === this.expected?.id),
        );
    if (event && ['done', 'unknown'].includes(event.state)) return false;
    if (
      event?.taskId &&
      (!this.expected ||
        event.taskId !== this.expected.id ||
        event.revision !== this.expected.revision)
    ) {
      event.state = 'unknown';
      await this.deps.options.checkpoint?.();
      return false;
    }
    if (event) event.state = 'processing';
    this.event = event;
    return true;
  }
}
