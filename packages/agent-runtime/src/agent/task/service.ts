import type { AICharacterTask } from '@voxel/shared';
import type { AgentConfig } from '../../contracts';
import { AgentRuntimeError } from '../../contracts/errors';
import type { RuntimeState } from '../../contracts/state';
import type {
  TaskAuthority,
  TaskCommand,
  TaskLease,
  TaskOutcome,
} from '../../contracts/task';
import type { RequestBudget } from './budget';
import { TaskPolicy } from './policy';

/** Task transactions; policy receives the execution owner directly. */
export class TaskService {
  constructor(readonly memory: RuntimeState) {}

  private policy() {
    return new TaskPolicy(this.memory.execution);
  }

  lease(): TaskLease {
    return this.policy().lease();
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
    return this.policy().command(command, authority, config);
  }

  async commit(
    command: TaskCommand,
    authority: TaskAuthority,
    config: AgentConfig,
    save: () => Promise<void>,
    budget?: RequestBudget,
    beforeNewTask?: (
      task: AICharacterTask,
      previous: RuntimeState,
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
      const usage = this.memory.character.usage;
      Object.assign(this.memory, before);
      this.memory.character.usage = usage;
      throw new AgentRuntimeError('无法保存任务检查点，已停止写操作。', true);
    }
  }

  finish(lease: TaskLease, outcome: TaskOutcome, turnMutated = false) {
    return this.policy().finish(lease, outcome, turnMutated);
  }
}
