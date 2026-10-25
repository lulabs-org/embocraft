import type { AICharacterTask, AICharacterUsage } from '@voxel/shared';
import type { AgentConfig } from '../../contracts';
import { AgentRuntimeError } from '../../contracts/errors';
import { isEndedTask } from './state';

export class BudgetExhausted extends AgentRuntimeError {
  constructor(message: string) {
    super(message, true);
  }
}

const chargedThrough = new WeakMap<AICharacterTask, number>();

/** Counts actual provider requests, never scheduler wakes or tool calls. */
export class RequestBudget {
  readonly usage: AICharacterUsage = { calls: 0, tokens: 0, estimated: false };
  started = Date.now();
  private attached?: AICharacterTask;
  private elapsedCharged = 0;
  constructor(
    readonly config: AgentConfig,
    readonly total: AICharacterUsage,
    task?: AICharacterTask,
  ) {
    this.attached = task;
  }
  get remainingMs() {
    return (
      (this.config.taskTimeoutMs ?? 900000) -
      (this.attached?.elapsedMs ?? this.elapsedCharged) -
      (Date.now() -
        Math.max(
          this.started + this.elapsedCharged,
          this.attached ? (chargedThrough.get(this.attached) ?? 0) : 0,
        ))
    );
  }
  check() {
    const scope = this.attached ?? this.usage;
    const reason =
      scope.calls >= this.config.maxTurns
        ? '已达到任务调用上限，请检查进展后手动继续。'
        : scope.tokens >= (this.config.tokenBudget ?? 50000)
          ? '已达到任务 token 预算，请检查进展后手动继续。'
          : this.remainingMs <= 0
            ? '已达到任务执行时间上限，请检查进展后手动继续。'
            : '';
    if (reason) throw new BudgetExhausted(reason);
  }
  begin() {
    this.check();
    this.usage.calls++;
    this.total.calls++;
    if (this.attached) this.attached.calls++;
    return Math.max(
      1,
      Math.min(
        this.config.maxTokens,
        (this.config.tokenBudget ?? 50000) -
          (this.attached ?? this.usage).tokens,
      ),
    );
  }
  finish(tokens: number, estimated: boolean) {
    tokens =
      Number.isFinite(tokens) && tokens >= 0
        ? Math.ceil(tokens)
        : this.config.maxTokens;
    for (const scope of [
      this.usage,
      this.total,
      ...(this.attached ? [this.attached] : []),
    ]) {
      scope.tokens += tokens;
      scope.estimated ||= estimated;
    }
  }
  attach(task: AICharacterTask) {
    if (this.attached === task) return;
    if (this.attached) {
      if (!isEndedTask(this.attached))
        throw new AgentRuntimeError('不能转移未结束任务的预算。', true);
      // The completed request remains charged to the old activity. Only future
      // requests accrue to the replacement; the character total never resets.
      this.flushTime();
      this.started = Date.now();
      this.elapsedCharged = 0;
      this.usage.calls = 0;
      this.usage.tokens = 0;
      this.usage.estimated = false;
    }
    this.attached = task;
    const through = this.started + this.elapsedCharged;
    task.elapsedMs += Math.max(
      0,
      through - Math.max(this.started, chargedThrough.get(task) ?? 0),
    );
    chargedThrough.set(task, Math.max(through, chargedThrough.get(task) ?? 0));
    task.calls += this.usage.calls;
    task.tokens += this.usage.tokens;
    task.estimated ||= this.usage.estimated;
  }
  flushTime() {
    const elapsed = Date.now() - this.started;
    if (this.attached) {
      const from = Math.max(
        this.started + this.elapsedCharged,
        chargedThrough.get(this.attached) ?? 0,
      );
      this.attached.elapsedMs += Math.max(0, Date.now() - from);
      chargedThrough.set(this.attached, Date.now());
    }
    this.elapsedCharged = elapsed;
  }
}

/** Checks if a task has reached its turn, token, or time cap. Returns failure reason if exceeded. */
export function checkBudgetCap(task: AICharacterTask, config: AgentConfig) {
  if (task.calls >= config.maxTurns)
    return '已达到任务调用上限，请检查进展后手动继续。';
  if (task.tokens >= (config.tokenBudget ?? 50000))
    return '已达到任务 token 预算，请检查进展后手动继续。';
  if (task.elapsedMs >= (config.taskTimeoutMs ?? 900000))
    return '已达到任务执行时间上限，请检查进展后手动继续。';
  return '';
}
