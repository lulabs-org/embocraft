import type { AgentAction } from '../../contracts';
import type { AgentRunState } from '../../contracts/state';
import type { ToolState } from '../../contracts/tool-state';
import { recordEvent } from '../task/inbox';
import type { TaskLease, TaskService } from '../task/service';

export type BackgroundActionHost = {
  service: TaskService;
  memory: AgentRunState;
  state: ToolState;
  activeSignal: AbortSignal;
  save: () => Promise<void>;
  launch: (
    id: string,
    controller: AbortController,
    work: Promise<void>,
  ) => void;
};

/** Long-running world actions that run asynchronously in the background slot. */
export function isBackgroundWorldAction(name: AgentAction['type']): boolean {
  return name === 'goto' || name === 'build' || name === 'house';
}

/** Marks an action as actively running in the durable effects section. */
export function markActiveActionRunning(
  memory: AgentRunState,
  id: string,
  name: string,
  lease: TaskLease,
): void {
  memory.effects.activeAction = {
    id,
    name,
    taskId: lease.id,
    revision: lease.revision,
    status: 'running',
  };
}

/**
 * Launches a long-running world action into the background slot, tracks its
 * `activeAction` state transitions, and records an `action_result` inbox event
 * when it settles.
 */
export async function launchBackgroundWorldAction(
  host: BackgroundActionHost,
  input: {
    id: string;
    name: string;
    lease: TaskLease;
    controller: AbortController;
    work: Promise<unknown>;
  },
) {
  const { id, name, lease, controller, work } = input;
  markActiveActionRunning(host.memory, id, name, lease);
  await host.save();

  const tracked = work
    .then(
      (value) => {
        if (host.service.current(lease))
          host.memory.effects.activeAction = {
            id,
            name,
            taskId: lease.id,
            revision: lease.revision,
            status: 'completed',
            result: {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(value, (key, val) =>
                    key === 'batchId' ? undefined : val,
                  ),
                },
              ],
              details: {},
            },
          };
      },
      (error) => {
        if (host.service.current(lease))
          host.memory.effects.activeAction = {
            id,
            name,
            taskId: lease.id,
            revision: lease.revision,
            status: host.activeSignal.aborted ? 'unknown' : 'failed',
            result: String(error),
          };
      },
    )
    .then(async () => {
      if (host.service.current(lease))
        recordEvent(host.memory, {
          id: `action:${id}`,
          kind: 'action_result',
          state: 'pending',
          at: Date.now(),
          audience: host.memory.task.current?.privateTo ?? 'public',
          taskId: lease.id,
          revision: lease.revision,
          actionId: id,
        });
      await host.save();
    });

  host.launch(id, controller, tracked);
  host.state.terminal = true;
  return { actionId: id, status: 'running' };
}

