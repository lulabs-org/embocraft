import type { AICharacterTask } from '@voxel/shared';
import type { AgentConfig } from '../../contracts';
import type { AgentRunState } from '../../contracts/state';
import type {
  TaskCommand as Command,
  TaskAuthority as Authority,
  TaskLease as Lease,
  TaskOutcome as Outcome,
} from '../../contracts/task';
import { AgentRuntimeError } from '../../contracts/errors';
import type { RequestBudget } from './budget';
import { TaskPolicy } from './policy';
import {
  applyTaskExecutionState,
  restoreStateSnapshot,
  taskExecutionState,
} from '../state/ownership';

// Preserve the existing service's type surface for internal and external callers.
export type TaskCommand = Command;
export type TaskAuthority = Authority;
export type TaskLease = Lease;
export type TaskOutcome = Outcome;

/** Compatibility/commit boundary; task rules receive execution state only. */
export class TaskService {
  constructor(readonly memory: AgentRunState) {}

  private policy() {
    return new TaskPolicy(taskExecutionState(this.memory));
  }

  private change<T>(operation: (policy: TaskPolicy) => T, replace = false): T {
    const policy = this.policy();
    try {
      const result = operation(policy);
      applyTaskExecutionState(this.memory, policy.memory, replace);
      return result;
    } finally {
      if (policy.issuedLease) this.memory.version = 3;
    }
  }

  lease(): TaskLease {
    return this.change((policy) => policy.lease());
  }

  current(lease: TaskLease) {
    return this.policy().current(lease);
  }

  assertCurrent(lease: TaskLease) {
    this.policy().assertCurrent(lease);
  }

  authorize(authority: TaskAuthority) {
    this.policy().authorize(authority);
  }

  command(
    command: TaskCommand,
    authority: TaskAuthority,
    config: AgentConfig,
  ): AICharacterTask {
    return this.change(
      (policy) => policy.command(command, authority, config),
      command.type === 'start',
    );
  }

  async commit(
    command: TaskCommand,
    authority: TaskAuthority,
    config: AgentConfig,
    save: () => Promise<void>,
    budget?: RequestBudget,
    beforeNewTask?: (
      task: AICharacterTask,
      previous: AgentRunState,
    ) => Promise<void>,
  ) {
    const before = structuredClone(this.memory);
    const task = this.command(command, authority, config);
    try {
      budget?.attach(task);
      if (command.type === 'start') await beforeNewTask?.(task, before);
      await save();
      return task;
    } catch {
      // A failed commit rolls back both scopes, but never erases provider usage.
      const usage = this.memory.task.usage;
      restoreStateSnapshot(this.memory, before);
      this.memory.task.usage = usage;
      throw new AgentRuntimeError('无法保存任务检查点，已停止写操作。', true);
    }
  }

  finish(lease: TaskLease, outcome: TaskOutcome, turnMutated = false) {
    return this.change((policy) => policy.finish(lease, outcome, turnMutated));
  }
}
