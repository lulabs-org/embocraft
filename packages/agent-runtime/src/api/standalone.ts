import type { AgentConfig } from '../contracts';
import type { AgentSession } from '../world/session/port';
import type { AgentAttention } from '../world/observe/attention';
import { emptyState, type AgentRunState } from '../contracts/state';
import type { RunOptions } from '../agent/turn/turn';
import { createAgentRuntime } from './runtime';

/** Existing CLI/library signature, backed by the same runtime as hosted characters. */
export async function runAgent(
  session: Pick<AgentSession, 'observe' | 'move' | 'request'>,
  runner: { run(options: RunOptions): Promise<void> },
  config: AgentConfig,
  signal: AbortSignal,
  log: (message: string) => void = console.log,
  memory: AgentRunState = emptyState(),
  attention?: AgentAttention,
) {
  const runtime = createAgentRuntime({
    session,
    runner,
    log,
    state: memory,
    attention,
  });
  await runtime.runUntilSettled(config, signal);
}
