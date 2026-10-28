import type { WorldEvent } from '@voxel/shared';
import type { ModelEndpoint } from '../../contracts';
import { AgentRuntimeError } from '../../contracts/errors';
import type { RuntimeState } from '../../contracts/state';
import { ActionRuntime } from '../action/runtime';
import { defaultEndpoint } from '../model/pi';
import { checkBudgetCap } from '../task/budget';
import { isActiveTask } from '../task/state';
import { restoreCheckpoint } from './checkpoint';
import { Turn, type RunOptions } from './turn';

type WakeCause =
  | { kind: 'message'; message: WorldEvent }
  | { kind: 'tick' | 'resume' };

function nextWakeCause(attention: RunOptions['attention']): WakeCause {
  const message = attention?.take();
  return message ? { kind: 'message', message } : { kind: 'tick' };
}

const running = new WeakSet<RuntimeState>();

/** The single serialized execution entrypoint for a character's wake-up. */
export class AgentRunner {
  constructor(
    private endpoint: ModelEndpoint = defaultEndpoint,
    private request: typeof fetch = fetch,
  ) {}

  async run(o: RunOptions): Promise<void> {
    if (running.has(o.memory))
      throw new AgentRuntimeError('Agent 已在运行。', true);
    running.add(o.memory);
    try {
      o.signal.throwIfAborted();
      await this.runWake(o);
    } finally {
      running.delete(o.memory);
    }
  }

  /** Local action progress and settlements precede event decisions. */
  private async runWake(o: RunOptions) {
    const { memory, signal } = o;
    const actions = new ActionRuntime(o);
    let cause = nextWakeCause(o.attention);
    if (cause.kind === 'tick') restoreCheckpoint(memory);
    await this.parkBudgetExhausted(o);
    try {
      while (!signal.aborted) {
        const step =
          cause.kind === 'tick'
            ? await actions.advance(
                async () => !(await this.parkBudgetExhausted(o)),
              )
            : 'idle';
        if (step === 'stop') return;
        if (step === 'resume') {
          // The action requests a decision to choose its next step.
          cause = { kind: 'resume' };
          continue;
        }
        if (
          cause.kind === 'tick' &&
          !isActiveTask(memory.execution.task.current)
        )
          return;
        if (!actions.isRunning || cause.kind !== 'tick')
          await this.turn(
            o,
            cause.kind === 'message' ? cause.message : undefined,
            actions,
          );
        cause = nextWakeCause(o.attention);
        if (cause.kind === 'message') continue;
        if (actions.isRunning) {
          await actions.wait(o.attention, signal);
          cause = nextWakeCause(o.attention);
          if (cause.kind === 'tick' && actions.isSettled) {
            await actions.complete();
            cause = { kind: 'resume' };
          }
          continue;
        }
        if (memory.execution.task.current?.status === 'running') {
          cause = { kind: 'resume' };
          continue;
        }
        return;
      }
    } finally {
      await actions.cleanup();
    }
  }

  /** Saves a task that cannot afford another request as 'budget'. */
  private async parkBudgetExhausted(o: RunOptions): Promise<boolean> {
    const task = o.memory.execution.task.current;
    if (!isActiveTask(task)) return false;
    const reason = checkBudgetCap(task, o.config);
    if (!reason) return false;
    task.status = 'budget';
    task.reason = reason;
    await o.checkpoint?.();
    return true;
  }

  private turn(
    o: RunOptions,
    message: WorldEvent | undefined,
    actions: ActionRuntime,
  ) {
    return new Turn({
      options: o,
      endpoint: this.endpoint,
      request: this.request,
      message,
      actions: {
        running: () => actions.isRunning,
        launch: (id, controller, work) => actions.launch(id, controller, work),
        stop: () => actions.stop(),
      },
    }).run();
  }
}
