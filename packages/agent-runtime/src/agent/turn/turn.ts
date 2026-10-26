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
import { TaskService, type TaskCommand, type TaskLease } from '../task/service';
import { isActiveTask, isEndedTask } from '../task/state';
import { createTaskControlTools } from '../tools/conversation';
import type { ToolHost } from '../tools/port';
import { createRuntimeWorldTools } from '../tools/world';
import { checkpointMessages } from './checkpoint';
import { runDecisionLoop } from './decide';
import { claimEvent, settleEvent } from './event';
import { TurnHealthMonitor } from './health';
import { buildDecisionPayload } from './input';
import { prepareDecision } from './prepare';
import { persistTranscript } from './transcript';

export type RunOptions = {
  session: AgentSession;
  config: AgentConfig;
  defaults?: AgentConfig;
  signal: AbortSignal;
  memory: AgentRunState;
  attention?: AgentAttention;
  log?: (message: string) => void;
  checkpoint?: () => void | Promise<void>;
  hooks?: {
    beforeNewTask?: (
      task: AICharacterTask,
      previous: AgentRunState,
    ) => Promise<void>;
  };
};

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

/** Message turns run on the character's own allowance when the host omits limits. */
const MESSAGE_TURN_LIMITS = {
  maxTurns: 100,
  tokenBudget: 50000,
  taskTimeoutMs: 900000,
};

/**
 * One decision flow for an addressed message, a plan instruction or an action
 * result. Owns the per-turn lease, budget, observation, configuration switch and
 * action-slot flags, and implements the ToolHost port that tool handlers use.
 */
export class Turn implements ToolHost {
  readonly session: AgentSession;
  readonly service: TaskService;
  readonly state: ToolState = initialToolState();
  readonly activeSignal: AbortSignal;
  readonly memory: AgentRunState;
  readonly budget: RequestBudget;
  readonly message?: WorldEvent;
  readonly attention?: AgentAttention;
  readonly log?: (message: string) => void;
  readonly beforeNewTaskHook?: (
    task: AICharacterTask,
    previous: AgentRunState,
  ) => Promise<void>;

  private readonly deps: TurnDeps;
  private readonly userConfig: AgentConfig;
  private readonly defaults: AgentConfig;
  private readonly currentConfig: AgentConfig;
  private readonly scope: string;
  private readonly health = new TurnHealthMonitor();
  private expected?: TaskLease;
  private event?: CharacterEvent;
  private preparedValue?: DecisionContext;
  private attached: boolean;
  private launched = false;
  private runningAction: boolean;

  constructor(deps: TurnDeps) {
    this.deps = deps;
    const { options } = deps;
    const { memory } = options;
    this.session = options.session;
    this.activeSignal = options.signal;
    this.memory = memory;
    this.message = deps.message;
    this.attention = options.attention;
    this.log = options.log;
    this.beforeNewTaskHook = options.hooks?.beforeNewTask;
    this.userConfig = options.config;
    this.defaults = options.defaults ?? options.config;
    this.service = new TaskService(memory);
    this.expected = memory.task.current ? this.service.lease() : undefined;
    this.attached = !deps.message;
    this.runningAction = deps.actions.running();
    this.scope = turnScope(deps.message, memory.task.current);
    this.currentConfig = {
      ...(deps.message ? this.defaults : this.userConfig),
    };
    if (deps.message) this.applyMessageTurnLimits();
    memory.task.usage ??= { calls: 0, tokens: 0, estimated: false };
    this.budget = new RequestBudget(
      this.currentConfig,
      memory.task.usage,
      deps.message ? undefined : memory.task.current,
    );
  }

  get config(): AgentConfig {
    return this.currentConfig;
  }

  get endpoint(): ModelEndpoint {
    return this.deps.endpoint;
  }

  get request(): typeof fetch {
    return this.deps.request;
  }

  prepared(): DecisionContext {
    if (!this.preparedValue)
      throw new AgentRuntimeError('决策上下文尚未准备，请先观察世界。', true);
    return this.preparedValue;
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
    if (!isActiveTask(task))
      throw new AgentRuntimeError('当前任务未运行，请先恢复或创建任务。');
    Object.assign(this.currentConfig, this.userConfig);
    this.budget.attach(task);
    this.attached = true;
  }

  /** Answers the addressed message; a related question may use the task allowance. */
  async respond(text: string, relatedToTask = false) {
    const task = this.memory.task.current;
    if (
      relatedToTask &&
      isActiveTask(task) &&
      !checkBudgetCap(task, this.userConfig)
    )
      this.attach();
    await this.send(text);
    this.state.terminal = true;
  }

  /**
   * Commits a player task command. The host owns configuration switching, budget
   * transfer, lease bookkeeping and the observer refresh so handlers only forward
   * the player's intent.
   */
  async commitTask(command: TaskCommand, reply?: string) {
    const message = this.message;
    if (!message) throw new AgentRuntimeError('任务控制需要明确玩家指令。');
    await this.stopAction();
    this.budget.flushTime();
    // Switching tasks within one event must never reset already charged usage.
    Object.assign(
      this.currentConfig,
      command.type === 'start' ? this.defaults : this.userConfig,
    );
    try {
      await this.service.commit(
        command,
        { kind: 'player', message },
        this.currentConfig,
        () => this.save(),
        this.budget,
        this.beforeNewTaskHook,
      );
    } catch (error) {
      if (error instanceof AgentRuntimeError && error.fatal) {
        this.state.persistenceFailed = true;
        this.state.terminal = true;
      }
      throw error;
    }
    this.expected = this.service.lease();
    this.attached = true;
    if (command.type === 'start')
      Object.assign(this.userConfig, this.currentConfig);
    if (command.type === 'pause') this.state.terminal = true;
    await this.observe();
    if (reply) await this.send(reply);
  }

  actionBusy() {
    return this.runningAction || this.launched;
  }

  launch(id: string, controller: AbortController, work: Promise<void>) {
    this.deps.actions.launch(id, controller, work);
    this.launched = true;
  }

  /** Resolve the queued event, run one Pi decision loop and settle the event. */
  async run() {
    const claim = await claimEvent({
      memory: this.memory,
      message: this.message,
      attention: this.attention,
      expected: this.expected,
      checkpoint: this.deps.options.checkpoint,
    });
    if (!claim) return;
    this.event = claim.event;
    try {
      const prepared = await this.prepare();
      if (!prepared) return;
      await this.decide(prepared);
      settleEvent(this.event, 'done');
    } catch (error) {
      this.settleFailure(error);
    } finally {
      if (!this.state.persistenceFailed) await this.save();
    }
  }

  /** Applies one message turn's default limits when the host config is open-ended. */
  private applyMessageTurnLimits() {
    const config = this.currentConfig;
    if (!Number.isFinite(config.maxTurns))
      config.maxTurns = MESSAGE_TURN_LIMITS.maxTurns;
    if (!Number.isFinite(config.tokenBudget))
      config.tokenBudget = MESSAGE_TURN_LIMITS.tokenBudget;
    if (!Number.isFinite(config.taskTimeoutMs))
      config.taskTimeoutMs = MESSAGE_TURN_LIMITS.taskTimeoutMs;
  }

  /** Observes the world and builds the decision input; undefined when unchanged. */
  private async prepare(): Promise<DecisionContext | undefined> {
    const { memory } = this;
    if (!this.message) {
      const task = memory.task.current;
      if (!task) throw new AgentRuntimeError('没有可执行的任务。');
      const reason = checkBudgetCap(task, this.currentConfig);
      if (reason) throw new AgentRuntimeError(reason);
    }
    const prepared = await prepareDecision(
      this.session,
      memory,
      this.activeSignal,
      this.message,
    );
    if (!prepared) return undefined;
    memory.health.lastProgress ??=
      worldSignature(prepared.observation, 'world') +
      JSON.stringify(prepared.observation.self);
    this.preparedValue = prepared;
    return prepared;
  }

  /** Runs one Pi decision loop with this turn's tools, transcript and health hooks. */
  private async decide(prepared: DecisionContext) {
    const { memory } = this;
    const history = this.message
      ? (memory.conversation.exchanges?.[this.scope] as Message[] | undefined)
      : checkpointMessages(memory);
    await runDecisionLoop({
      config: this.currentConfig,
      endpoint: this.deps.endpoint,
      request: this.deps.request,
      budget: this.budget,
      signal: this.activeSignal,
      state: this.state,
      sessionKey: this.session,
      interactionHistory: !!this.message,
      prompt: characterPrompt(this.currentConfig),
      tools: [
        ...createTaskControlTools(this),
        ...createRuntimeWorldTools(this),
      ],
      history,
      input: buildDecisionPayload({
        config: this.currentConfig,
        message: this.message,
        prepared,
        memory,
        event: this.event,
      }),
      save: () => this.save(),
      shouldYield: () =>
        !this.ownsLease() || (!this.message && !!this.attention?.pending),
      contextEpoch: () =>
        `${memory.task.identity?.id}:${memory.task.identity?.revision}`,
      afterTurn: () =>
        this.health.recordTurn({
          maxStalledTurns: this.currentConfig.maxStalledTurns,
          state: this.state,
          attached: this.attached,
          current: () => this.ownsLease(),
          memory,
          service: this.service,
          hasMessage: !!this.message,
          launched: this.launched,
          // Read the latest snapshot: tools may refresh the observation after
          // this decision started.
          observation: this.prepared().observation,
        }),
      transcript: (messages) =>
        persistTranscript({
          memory,
          messages,
          scope: this.scope,
          hasMessage: !!this.message,
          attached: this.attached,
          apiKey: this.currentConfig.apiKey,
          save: () => this.save(),
        }),
    });
  }

  /** Settles a failed turn: log, park the task and mark the event unknown. */
  private settleFailure(error: unknown) {
    const { memory } = this;
    if (!this.activeSignal.aborted) {
      const reason =
        error instanceof Error ? error.message : '角色事件处理失败。';
      memory.health.lastResponse = reason;
      this.log?.(reason);
      this.parkFailedTask(reason);
    }
    settleEvent(this.event, 'unknown');
    if (this.state.persistenceFailed) throw error;
  }

  /** A failed decision parks an attached, current task as budget or blocked. */
  private parkFailedTask(reason: string) {
    const task = this.memory.task.current;
    if (!this.attached || !this.ownsLease() || !task || isEndedTask(task))
      return;
    task.status = checkBudgetCap(task, this.currentConfig)
      ? 'budget'
      : 'blocked';
    task.reason = reason;
  }

  /** The turn still owns the task revision it started with. */
  private ownsLease(): boolean {
    return !this.expected || this.service.current(this.expected);
  }

  private async stopAction() {
    await this.deps.actions.stop();
    this.runningAction = false;
    this.launched = false;
  }

  private async send(text: string) {
    const { memory, activeSignal } = this;
    memory.health.lastResponse = text;
    if (!aiCharacterPermissions(this.currentConfig).chat) {
      this.log?.(text);
      await this.save();
      return;
    }
    await paceChat(memory, activeSignal);
    settleEvent(this.event, 'unknown');
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
}

/** Public scope stays public; private and nearby scopes answer their actor. */
function turnScope(
  message: WorldEvent | undefined,
  task: AICharacterTask | undefined,
): string {
  if (!message) return task?.privateTo ?? 'public';
  return (message.data as ChatData).scope === 'public'
    ? 'public'
    : message.actor;
}
