import type { ActiveAction, AgentRunState } from '../../contracts/state';
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
          settleActiveAction(host.memory, host.service, lease, {
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
          });
      },
      (error) => {
        if (host.service.current(lease))
          settleActiveAction(host.memory, host.service, lease, {
            id,
            name,
            taskId: lease.id,
            revision: lease.revision,
            status: host.activeSignal.aborted ? 'unknown' : 'failed',
            result: String(error),
          });
      },
    )
    .then(async () => {
      recordActionResult(host.memory, host.service, lease, id);
      await host.save();
    });

  host.launch(id, controller, tracked);
  host.state.terminal = true;
  return { actionId: id, status: 'running' };
}

/** A late action may never replace the next task revision's result. */
export function settleActiveAction(
  memory: AgentRunState,
  service: TaskService,
  lease: TaskLease,
  action: ActiveAction,
): void {
  if (service.current(lease)) memory.effects.activeAction = action;
}

/** Keep settlement and event publication separate to preserve checkpoint ordering. */
export function recordActionResult(
  memory: AgentRunState,
  service: TaskService,
  lease: TaskLease,
  actionId: string,
  event: { id?: string; detail?: string } = {},
): void {
  if (!service.current(lease)) return;
  recordEvent(memory, {
    id: event.id ?? `action:${actionId}`,
    kind: 'action_result',
    state: 'pending',
    at: Date.now(),
    audience: memory.task.current?.privateTo ?? 'public',
    taskId: lease.id,
    revision: lease.revision,
    actionId,
    ...(event.detail === undefined ? {} : { detail: event.detail }),
  });
}
