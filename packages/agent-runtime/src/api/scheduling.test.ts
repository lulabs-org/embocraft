import { expect, it, vi } from 'vitest';
import { testAgentConfig } from '../../../../tests/support/agent-config';
import { AgentRunner } from '../agent/turn/wake';
import { MemorySession } from '../testing/memory-session';
import { createAgentRuntime } from './runtime';

it('runs the initial CLI goal and continues waiting until the execution settles', async () => {
  vi.useFakeTimers();
  const phases: string[] = [];
  const run = vi
    .spyOn(AgentRunner.prototype, 'run')
    .mockImplementation(async ({ memory }) => {
      phases.push(memory.execution.task.current!.status);
      memory.execution.task.current!.status =
        phases.length === 1 ? 'waiting' : 'completed';
    });
  try {
    const config = { ...testAgentConfig(), intervalMs: 10 };
    const runtime = createAgentRuntime({ session: new MemorySession() });
    const done = runtime.runUntilSettled(config, new AbortController().signal);
    await vi.runAllTimersAsync();
    await done;
    expect(phases).toEqual(['running', 'waiting']);
    expect(runtime.view().task).toMatchObject({
      status: 'completed',
      goal: config.goal,
    });
  } finally {
    run.mockRestore();
    vi.useRealTimers();
  }
});
