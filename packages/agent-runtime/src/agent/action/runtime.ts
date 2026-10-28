import { followingAction } from './follow';
import type { ActionRunOptions, ActionStep } from './port';
import type { AgentRunState } from '../../contracts/state';
import { isActiveTask } from '../task/state';
import type { AgentAttention } from '../../world/observe/attention';

export interface ActionEntry {
  id: string;
  controller: AbortController;
  settled: boolean;
  done: Promise<void>;
}

/** One wake's action slot: background work, saved continuations and cancellation. */
export class ActionRuntime {
  constructor(private readonly options: ActionRunOptions) {}

  async advance(canAdvance: () => Promise<boolean>): Promise<ActionStep> {
    const { memory } = this.options;
    const action = continuingAction(memory);
    if (!action || !isActiveTask(memory.task.current)) return 'idle';
    if (!(await canAdvance())) return 'stop';
    return action.advance(this.options);
  }

  private current?: ActionEntry;

  get isRunning(): boolean {
    return !!this.current;
  }

  get isSettled(): boolean {
    return !!this.current?.settled;
  }

  launch(id: string, controller: AbortController, work: Promise<void>): void {
    const entry: ActionEntry = {
      id,
      controller,
      settled: false,
      done: work.finally(() => {
        entry.settled = true;
      }),
    };
    this.current = entry;
  }

  async complete(): Promise<void> {
    if (this.current) {
      await this.current.done;
      this.current = undefined;
    }
  }

  async stop(): Promise<void> {
    this.current?.controller.abort();
    await this.complete();
  }

  async wait(
    attention: AgentAttention | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.current || this.current.settled) return;

    await (attention
      ? Promise.race([this.current.done, attention.wait(60_000, signal)])
      : this.current.done);
  }

  async cleanup(): Promise<void> {
    await this.stop();
  }
}

function continuingAction(memory: AgentRunState) {
  return followingAction.pending(memory) ? followingAction : undefined;
}

/** The host need not know which concrete action requests a local wake. */
export function actionWakeDelay(memory: AgentRunState): number | undefined {
  return continuingAction(memory)?.wakeDelayMs;
}
