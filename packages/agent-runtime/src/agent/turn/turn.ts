import type { Message } from '@earendil-works/pi-ai';
import {
  aiCharacterPermissions,
  type AICharacterTask,
  type ChatData,
  type WorldEvent,
} from '@voxel/shared';
import type { AgentAction } from '../../contracts/action';
import type { AgentConfig, ModelEndpoint } from '../../contracts/config';
import { AgentRuntimeError } from '../../contracts/errors';
import type { DecisionContext, Observation } from '../../contracts/observation';
import type { CharacterEvent, RuntimeState } from '../../contracts/state';
import type { TaskCommand, TaskLease, TaskOutcome } from '../../contracts/task';
import { initialToolState, type ToolState } from '../../contracts/tool-state';
import { cancellable } from '../../kernel/abort';
import type { AgentAttention } from '../../world/observe/attention';
import { worldSignature } from '../../world/observe/extract';
import type { AgentSession } from '../../world/session/port';
import { paceChat } from '../action/chat-pacing';
import { executeTaskActions, executeTurnWorldAction } from '../action/executor';
import { characterPrompt } from '../prompt/character';
import { buildDecisionPayload } from '../prompt/view';
import { checkBudgetCap } from '../task/budget';
import { isActiveTask, isEndedTask } from '../task/state';
import { createTaskControlTools } from '../tools/conversation';
import type { ToolHost, ToolTaskOutcome } from '../tools/port';
import { createTaskTools } from '../tools/task';
import { createRuntimeWorldTools } from '../tools/world';
import { TurnBinding } from './binding';
import { checkpointMessages } from './checkpoint';
import { runDecisionLoop } from './decide';
import { claimEvent, settleEvent } from './event';
import { TurnHealthMonitor } from './health';
import { prepareDecision } from './prepare';
import { persistTranscript } from './transcript';

export type RunOptions = {
  session: AgentSession;
  config: AgentConfig;
  defaults?: AgentConfig;
  signal: AbortSignal;
  memory: RuntimeState;
  attention?: AgentAttention;
  log?: (message: string) => void;
  checkpoint?: () => void | Promise<void>;
  hooks?: {
    beforeNewTask?: (
      task: AICharacterTask,
      previous: RuntimeState,
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

/**
 * One decision flow for an addressed message, a plan instruction or an action
 * result. Owns event handling and the action slot; TurnBinding owns the
 * per-turn task lease, budget and configuration switch.
 */
export class Turn implements ToolHost {
  private readonly session: AgentSession;
  private readonly state: ToolState = initialToolState();
  private readonly activeSignal: AbortSignal;
  private readonly memory: RuntimeState;
  private readonly message?: WorldEvent;
  private readonly attention?: AgentAttention;
  private readonly log?: (message: string) => void;
  private readonly beforeNewTaskHook?: (
    task: AICharacterTask,
    previous: RuntimeState,
  ) => Promise<void>;

  private readonly deps: TurnDeps;
  private readonly binding: TurnBinding;
  private readonly scope: string;
  private readonly health = new TurnHealthMonitor();
  private event?: CharacterEvent;
  private preparedValue?: DecisionContext;
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
    this.binding = new TurnBinding(
      memory,
      options.config,
      options.defaults ?? options.config,
      deps.message,
    );
    this.runningAction = deps.actions.running();
    this.scope = turnScope(deps.message, memory.execution.task.current);
  }

  private get config(): AgentConfig {
    return this.binding.config;
  }

  private get service() {
    return this.binding.service;
  }

  private get budget() {
    return this.binding.budget;
  }

  private prepared(): DecisionContext {
    if (!this.preparedValue)
      throw new AgentRuntimeError('决策上下文尚未准备，请先观察世界。', true);
    return this.preparedValue;
  }

  private async observe() {
    const next = await prepareDecision(
      this.session,
      this.memory,
      this.activeSignal,
      this.message,
    );
    if (next) this.preparedValue = next;
  }

  private async save() {
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

  private authorize() {
    this.binding.authorize();
  }

  private attach() {
    this.binding.attach();
  }

  async observeWorld(): Promise<{
    observation: Observation;
    activity: DecisionContext['context'];
  }> {
    await this.observe();
    return {
      observation: this.prepared().observation,
      activity: this.prepared().context,
    };
  }

  /** Answers the addressed message; a related question may use the task allowance. */
  async respond(text: string, relatedToTask = false) {
    if (relatedToTask && this.binding.canAttachForReply()) this.attach();
    await this.send(text);
    this.state.terminal = true;
  }

  /** Stops the old action, commits the task binding, then refreshes the view. */
  async commitTask(
    command: TaskCommand,
    reply?: string,
  ): Promise<AICharacterTask> {
    const message = this.message;
    if (!message) throw new AgentRuntimeError('任务控制需要明确玩家指令。');
    this.authorize();
    await this.stopAction();
    try {
      await this.binding.commitTask(
        command,
        message,
        () => this.save(),
        this.beforeNewTaskHook,
      );
    } catch (error) {
      if (error instanceof AgentRuntimeError && error.fatal) {
        this.state.persistenceFailed = true;
        this.state.terminal = true;
      }
      throw error;
    }
    if (command.type === 'pause') this.state.terminal = true;
    await this.observe();
    if (reply) await this.send(reply);
    return this.memory.execution.task.current!;
  }

  async settleTask(
    outcome: ToolTaskOutcome,
    questionToAsk?: string,
  ): Promise<{ status: AICharacterTask['status']; summary: string }> {
    const lease = this.claimActiveTaskLease();
    this.activeSignal.throwIfAborted();
    this.service.assertCurrent(lease);
    if (
      this.state.terminal ||
      this.state.skipBatch ||
      !!this.attention?.pending
    )
      throw new AgentRuntimeError('当前批次已停止。');
    const taskOutcome: TaskOutcome =
      outcome.status === 'waiting'
        ? {
            ...outcome,
            signature: worldSignature(
              this.prepared().observation,
              outcome.waitFor,
            ),
          }
        : outcome;
    this.service.finish(lease, taskOutcome, this.state.turnMutated);
    this.state.terminal = true;
    await this.save();
    if (
      questionToAsk &&
      aiCharacterPermissions(this.config).chat &&
      this.memory.execution.checkpoint.unknownEffect?.name !== 'chat'
    ) {
      const chatOutcome = await executeTaskActions(
        this.session,
        [{ type: 'chat', text: questionToAsk }],
        this.prepared().observation,
        this.config,
        this.activeSignal,
        this.memory,
        this.budget,
        lease,
        () => this.save(),
        this.attention,
        this.log,
      );
      await this.refreshObservation(chatOutcome.observation);
    }
    return {
      status: this.memory.execution.task.current!.status,
      summary: this.memory.execution.task.current!.summary,
    };
  }

  async executeWorldAction(
    id: string,
    action: AgentAction,
    relatedToTask = false,
  ): Promise<unknown> {
    if (action.type === 'chat' && this.message) {
      await this.respond(action.text, relatedToTask);
      return { replied: true };
    }
    const lease = this.claimActiveTaskLease();
    return executeTurnWorldAction({
      id,
      action,
      lease,
      session: this.session,
      config: this.config,
      budget: this.budget,
      service: this.service,
      memory: this.memory,
      state: this.state,
      activeSignal: this.activeSignal,
      attention: this.attention,
      log: this.log,
      observation: () => this.prepared().observation,
      refreshObservation: (observation) => this.refreshObservation(observation),
      save: () => this.save(),
      launch: (actionId, controller, work) =>
        this.launch(actionId, controller, work),
    });
  }

  private claimActiveTaskLease(): TaskLease {
    this.authorize();
    if (this.actionBusy())
      throw new AgentRuntimeError('当前动作尚未结束，请读取进度或先明确停止。');
    if (!isActiveTask(this.memory.execution.task.current))
      throw new AgentRuntimeError(
        'No active running task. For a NEW human action request, call start_task(goal) FIRST, then retry the world tool. Do not claim completion: no world action was executed. A paused or exhausted task must be resumed, never recreated.',
      );
    this.attach();
    return this.service.lease();
  }

  private async refreshObservation(observation: Observation) {
    this.prepared().observation = {
      ...observation,
      attention: this.message,
    };
    await this.observe();
  }

  private actionBusy() {
    return this.runningAction || this.launched;
  }

  private launch(id: string, controller: AbortController, work: Promise<void>) {
    this.deps.actions.launch(id, controller, work);
    this.launched = true;
  }

  /** Resolve the queued event, run one Pi decision loop and settle the event. */
  async run() {
    const claim = await claimEvent({
      memory: this.memory,
      message: this.message,
      attention: this.attention,
      expected: this.binding.lease,
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

  /** Observes the world and builds the decision input; undefined when unchanged. */
  private async prepare(): Promise<DecisionContext | undefined> {
    const { memory } = this;
    if (!this.message) {
      const task = memory.execution.task.current;
      if (!task) throw new AgentRuntimeError('没有可执行的任务。');
      const reason = checkBudgetCap(task, this.config);
      if (reason) throw new AgentRuntimeError(reason);
    }
    const prepared = await prepareDecision(
      this.session,
      memory,
      this.activeSignal,
      this.message,
    );
    if (!prepared) return undefined;
    memory.execution.health.lastProgress ??=
      worldSignature(prepared.observation, 'world') +
      JSON.stringify(prepared.observation.self);
    this.preparedValue = prepared;
    return prepared;
  }

  /** Runs one Pi decision loop with this turn's tools, transcript and health hooks. */
  private async decide(prepared: DecisionContext) {
    const { memory } = this;
    const history = this.message
      ? (memory.character.conversation.exchanges?.[this.scope] as
          | Message[]
          | undefined)
      : checkpointMessages(memory);
    await runDecisionLoop({
      config: this.config,
      endpoint: this.deps.endpoint,
      request: this.deps.request,
      budget: this.budget,
      signal: this.activeSignal,
      state: this.state,
      interactionHistory: !!this.message,
      prompt: characterPrompt(this.config),
      tools: [
        ...createTaskControlTools(this),
        ...createRuntimeWorldTools(this),
        ...createTaskTools(this),
      ],
      history,
      input: buildDecisionPayload({
        config: this.config,
        message: this.message,
        prepared,
        memory,
        event: this.event,
      }),
      save: () => this.save(),
      shouldYield: () =>
        !this.binding.ownsLease() ||
        (!this.message && !!this.attention?.pending),
      contextEpoch: () =>
        `${memory.execution.task.identity?.id}:${memory.execution.task.identity?.revision}`,
      afterTurn: () => this.recordDecisionHealth(),
      transcript: (messages) => this.saveDecisionTranscript(messages),
    });
  }

  private recordDecisionHealth() {
    this.health.recordTurn({
      maxStalledTurns: this.config.maxStalledTurns,
      state: this.state,
      attached: this.binding.isAttached,
      current: () => this.binding.ownsLease(),
      memory: this.memory,
      service: this.service,
      hasMessage: !!this.message,
      launched: this.launched,
      // Tools may refresh the observation after this decision started.
      observation: this.prepared().observation,
    });
  }

  private saveDecisionTranscript(messages: Message[]) {
    return persistTranscript({
      memory: this.memory,
      messages,
      scope: this.scope,
      hasMessage: !!this.message,
      attached: this.binding.isAttached,
      apiKey: this.config.apiKey,
      save: () => this.save(),
    });
  }

  /** Settles a failed turn: log, park the task and mark the event unknown. */
  private settleFailure(error: unknown) {
    const { memory } = this;
    if (!this.activeSignal.aborted) {
      const reason =
        error instanceof Error ? error.message : '角色事件处理失败。';
      memory.execution.health.lastResponse = reason;
      this.log?.(reason);
      this.parkFailedTask(reason);
    }
    settleEvent(this.event, 'unknown');
    if (this.state.persistenceFailed) throw error;
  }

  /** A failed decision parks an attached, current task as budget or blocked. */
  private parkFailedTask(reason: string) {
    const task = this.memory.execution.task.current;
    if (
      !this.binding.isAttached ||
      !this.binding.ownsLease() ||
      !task ||
      isEndedTask(task)
    )
      return;
    task.status = checkBudgetCap(task, this.config) ? 'budget' : 'blocked';
    task.reason = reason;
  }

  private async stopAction() {
    await this.deps.actions.stop();
    this.runningAction = false;
    this.launched = false;
  }

  private async send(text: string) {
    const { memory, activeSignal } = this;
    memory.execution.health.lastResponse = text;
    if (!aiCharacterPermissions(this.config).chat) {
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
