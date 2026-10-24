import { setTimeout as pause } from 'node:timers/promises';
import type { AgentConfig } from '../contracts';
import type { AgentSession } from '../world/session/port';
import type { AgentAttention } from '../world/observe/attention';
import { emptyState, type AgentRunState } from '../contracts/state';
import { newTask } from './task/state';
import type { RunOptions } from './turn/options';

/** Draw a fresh inclusive interval after a completed turn; requests never overlap. */
export function nextIntervalMs(
  config: Pick<
    AgentConfig,
    'intervalMode' | 'intervalMs' | 'intervalMinMs' | 'intervalMaxMs'
  >,
  random = Math.random,
): number {
  return config.intervalMode === 'random'
    ? config.intervalMinMs +
        Math.floor(random() * (config.intervalMaxMs - config.intervalMinMs + 1))
    : config.intervalMs;
}

/** CLI host: Pi owns active execution; only waiting/event wake-ups are scheduled here. */
export async function runAgent(
  session: Pick<AgentSession, 'observe' | 'move' | 'request'>,
  runner: { run(options: RunOptions): Promise<void> },
  config: AgentConfig,
  signal: AbortSignal,
  log: (message: string) => void = console.log,
  memory: AgentRunState = emptyState(),
  attention?: AgentAttention,
) {
  memory.task.current ??= newTask(config.goal);
  do {
    if (signal.aborted) break;
    await runner.run({ session, config, signal, memory, attention, log });
    if (
      signal.aborted ||
      (!attention?.pending && memory.task.current?.status !== 'waiting')
    )
      break;
    if (attention)
      await attention.wait(
        memory.effects.follow ? 100 : nextIntervalMs(config),
        signal,
      );
    else
      await pause(
        memory.effects.follow ? 100 : nextIntervalMs(config),
        undefined,
        {
          signal,
        },
      ).catch(() => {});
  } while (!signal.aborted);
}
