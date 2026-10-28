import type { AICharacterTask, WorldEvent } from '@voxel/shared';
import type { AgentConfig } from '../../contracts/config';
import { AgentRuntimeError } from '../../contracts/errors';
import type { RuntimeState } from '../../contracts/state';
import type { TaskCommand, TaskLease } from '../../contracts/task';
import { checkBudgetCap, RequestBudget } from '../task/budget';
import { TaskService } from '../task/service';
import { isActiveTask } from '../task/state';

/** Message turns use the character allowance when the host omits limits. */
const MESSAGE_TURN_LIMITS = {
  maxTurns: 100,
  tokenBudget: 50000,
  taskTimeoutMs: 900000,
};

/** Owns the configuration, budget and lease that change when a message joins a task. */
export class TurnBinding {
  readonly service: TaskService;
  readonly budget: RequestBudget;
  readonly config: AgentConfig;
  private expected?: TaskLease;
  private attached: boolean;

  constructor(
    private readonly memory: RuntimeState,
    private readonly taskConfig: AgentConfig,
    private readonly defaults: AgentConfig,
    private readonly message?: WorldEvent,
  ) {
    this.service = new TaskService(memory);
    this.expected = memory.execution.task.current
      ? this.service.lease()
      : undefined;
    this.attached = !message;
    this.config = { ...(message ? defaults : taskConfig) };
    if (message) this.applyMessageLimits();
    memory.character.usage ??= { calls: 0, tokens: 0, estimated: false };
    this.budget = new RequestBudget(
      this.config,
      memory.character.usage,
      message ? undefined : memory.execution.task.current,
    );
  }

  get lease(): TaskLease | undefined {
    return this.expected;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  ownsLease(): boolean {
    return !this.expected || this.service.current(this.expected);
  }

  authorize() {
    if (this.expected) this.service.assertCurrent(this.expected);
    if (this.message)
      this.service.authorize({ kind: 'player', message: this.message });
  }

  attach() {
    if (this.attached) return;
    this.authorize();
    const task = this.memory.execution.task.current;
    if (!isActiveTask(task))
      throw new AgentRuntimeError('当前任务未运行，请先恢复或创建任务。');
    Object.assign(this.config, this.taskConfig);
    this.budget.attach(task);
    this.attached = true;
  }

  canAttachForReply(): boolean {
    const task = this.memory.execution.task.current;
    return isActiveTask(task) && !checkBudgetCap(task, this.taskConfig);
  }

  /** Commit the whole binding transition after the caller stops any prior action. */
  async commitTask(
    command: TaskCommand,
    message: WorldEvent,
    save: () => Promise<void>,
    beforeNewTask?: (
      task: AICharacterTask,
      previous: RuntimeState,
    ) => Promise<void>,
  ) {
    this.budget.flushTime();
    // Keep this object stable so the in-flight Pi decision sees the switch.
    Object.assign(
      this.config,
      command.type === 'start' ? this.defaults : this.taskConfig,
    );
    await this.service.commit(
      command,
      { kind: 'player', message },
      this.config,
      save,
      this.budget,
      beforeNewTask,
    );
    this.expected = this.service.lease();
    this.attached = true;
    if (command.type === 'start') Object.assign(this.taskConfig, this.config);
  }

  private applyMessageLimits() {
    if (!Number.isFinite(this.config.maxTurns))
      this.config.maxTurns = MESSAGE_TURN_LIMITS.maxTurns;
    if (!Number.isFinite(this.config.tokenBudget))
      this.config.tokenBudget = MESSAGE_TURN_LIMITS.tokenBudget;
    if (!Number.isFinite(this.config.taskTimeoutMs))
      this.config.taskTimeoutMs = MESSAGE_TURN_LIMITS.taskTimeoutMs;
  }
}
