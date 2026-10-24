// Deterministic decision adapter for existing domain-policy fixtures. No production inference.
import type { Planner } from './decision-fixture';
import { setTimeout as pause } from 'node:timers/promises';
import type { AgentConfig } from '../../packages/agent-runtime/src/contracts';
import type { AgentSession } from '../../packages/agent-runtime/src/world/session/port';
import type { AgentAttention } from '../../packages/agent-runtime/src/world/observe/attention';
import type { AgentRunState } from '../../packages/agent-runtime/src/contracts/state';
import { newTask } from '../../packages/agent-runtime/src/agent/task/state';
import { emptyState } from '@voxel/agent-runtime';
import { runTaskStep } from './decision-step';

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

/** CLI task runner. Managed agents schedule exactly one runTaskStep per wake. */
export async function runAgent(
  session: Pick<AgentSession, 'observe' | 'move' | 'request'>,
  planner: Planner,
  config: AgentConfig,
  signal: AbortSignal,
  log: (message: string) => void = console.log,
  memory: AgentRunState = emptyState(),
  attention?: AgentAttention,
) {
  memory.task.current ??= newTask(config.goal);
  do {
    if (signal.aborted) break;
    await runTaskStep(session, planner, config, signal, memory, attention, log);
    if (
      signal.aborted ||
      (!attention?.pending && memory.task.current?.status !== 'running')
    )
      break;
    if (attention) await attention.wait(nextIntervalMs(config), signal);
    else
      await pause(nextIntervalMs(config), undefined, { signal }).catch(
        () => {},
      );
  } while (!signal.aborted);
}
