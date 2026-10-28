import { expect, it, vi } from 'vitest';
import { runAgent } from './standalone';
import { createAgentRuntime } from './runtime';
import { emptyState } from '../contracts/state';
import { MemorySession } from '../testing/memory-session';
import type { RunOptions } from '../agent/turn/turn';
import { testAgentConfig } from '../../../../tests/support/agent-config';

it('keeps the CLI compatibility signature on the same waiting loop as the runtime facade', async () => {
  vi.useFakeTimers();
  try {
    const exercise = async (legacy: boolean) => {
      const memory = emptyState();
      const config = { ...testAgentConfig(), intervalMs: 10 };
      const session = new MemorySession();
      const phases: string[] = [];
      const runner = {
        run: async ({ memory: state }: RunOptions) => {
          expect(state).toBe(memory);
          phases.push(state.task.current!.status);
          state.task.current!.status =
            phases.length === 1 ? 'waiting' : 'completed';
        },
      };
      const signal = new AbortController().signal;
      const done = legacy
        ? runAgent(session, runner, config, signal, () => {}, memory)
        : createAgentRuntime({
            session,
            runner,
            state: memory,
          }).runUntilSettled(config, signal);
      await vi.runAllTimersAsync();
      await done;
      return {
        phases,
        status: memory.task.current?.status,
        goal: memory.task.current?.goal,
      };
    };
    const legacy = await exercise(true);
    expect(legacy.phases).toEqual(['running', 'waiting']);
    expect(legacy.status).toBe('completed');
    expect(await exercise(false)).toEqual(legacy);
  } finally {
    vi.useRealTimers();
  }
});
