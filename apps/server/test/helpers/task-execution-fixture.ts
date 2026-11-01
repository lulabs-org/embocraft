import { createAgentRuntime } from '@voxel/agent-runtime';
import { emptyState, newTask } from '@voxel/agent-runtime/testing';

import { vi } from 'vitest';

import type { WorldEvent } from '@voxel/shared';

import { TaskCoordinator } from '../../src/modules/tasks/services/coordinator.service';

import type {
  TaskExecutionState,
  TaskHostPort,
} from '../../src/modules/tasks/ports';

export function taskExecutionFixture() {
  let afterInterrupt = async () => {};
  const save = vi.fn(async () => {});
  const stopped = vi.fn();
  const host: TaskHostPort = {
    execution: () => state,
    findExecution: () => state,
    executions: () => [state],
    save,
    schedule: vi.fn(),
    launch: vi.fn(),
    async withStoppedExecution(id, change) {
      stopped(id);
      await afterInterrupt();
      return change();
    },
    validateExecution: (_id, overrides) => ({ ...state.view, ...overrides }),
    storageFailed: () => false,
    committedName: () => state.view.name,
    publicIdentity: () => state.runtime.view().identity,
    resourceVersion: () => 1,
    isClosing: () => false,
    assertWritable: () => {},
  };
  const tasks = new TaskCoordinator(host);
  const runtime = createAgentRuntime({
    state: {
      version: 4 as const,
      character: { ...emptyState().character },
      execution: {
        ...emptyState().execution,
        task: {
          current: {
            ...newTask('Private work', 'alice', 'alice'),
            status: 'waiting',
          },
        },
      },
    },
  });
  const state: TaskExecutionState = {
    runtime,
    view: {
      permissions: { move: true, chat: true, place: false, remove: false },
      id: 'actor',
      name: 'Fixture',
      providerId: 'fixture',
      model: 'fixture',
      status: 'idle',
      logEntries: [],

      maxTurns: 20,
      tokenBudget: 50000,
      taskTimeoutMs: 900000,
      intervalMode: 'fixed',
      intervalMs: 60000,
      intervalMinMs: 4000,
      intervalMaxMs: 8000,
      timeoutMs: 30000,
      maxTokens: 1024,
      thinking: 'disabled',
      reasoningEffort: 'none',
    },
    ledger: tasks.plans,
    online: true,
    currentRunId: undefined,
  };
  const lease = runtime.lease();
  const message: WorldEvent = {
    seq: 1,
    type: 'chat',
    actor: 'alice',
    actorKind: 'human',
    at: 100,
    data: {
      text: '暂停',
      name: 'Alice',
      kind: 'text',
      scope: 'private',
      recipients: ['actor'],
    },
  };
  return {
    state,
    tasks,
    save,
    stopped,
    host,
    lease,
    message,
    setAfterInterrupt: (fn: () => Promise<void>) => {
      afterInterrupt = fn;
    },
  };
}
