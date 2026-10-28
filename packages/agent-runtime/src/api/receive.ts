import type { ChatData, WorldEvent } from '@voxel/shared';
import type { AgentRunState } from '../contracts/state';
import type { AgentAttention } from '../world/observe/attention';
import type { AgentSession } from '../world/session/port';
import { parseControlCommand } from '../agent/task/commands';
import { recordChatEvent, recordEvent } from '../agent/task/inbox';
import { TaskService } from '../agent/task/service';
import type { RuntimeReceiveOptions, RuntimeReceiveResult } from './ports';

/** One intake path, including persistence ordering and trusted control-message routing. */
export async function receiveWorldEvent(input: {
  state: () => AgentRunState;
  attention: () => AgentAttention;
  selfId: string;
  session?: AgentSession;
  event: WorldEvent;
  options: RuntimeReceiveOptions;
}): Promise<RuntimeReceiveResult> {
  const { event, options } = input;
  if (!input.attention().accept(event, input.selfId)) return 'ignored';
  const operation = options.control
    ? parseControlCommand((event.data as ChatData).text)
    : undefined;
  const service = new TaskService(input.state());
  let authorized = false;
  if (operation && input.state().task.current) {
    try {
      service.authorize({ kind: 'player', message: event });
      authorized = true;
    } catch {
      /* Unauthorized controls remain ordinary conversation. */
    }
  }
  if (operation && authorized) {
    await options.control!({
      operation,
      lease: service.lease(),
      commandId: `world-${input.attention().generation}-${event.seq}`,
      message: event,
    });
    recordEvent(input.state(), {
      id: `control:${input.attention().generation}:${event.seq}`,
      kind: 'control',
      state: 'done',
      at: event.at,
      audience: event.actor,
      actor: event.actor,
      detail: operation,
    });
    options.controlCommitted?.();
    if (options.replyToControl)
      await input.session?.request('chat', {
        text:
          operation === 'cancel'
            ? '任务已取消，我会留在这里待命。'
            : '任务已暂停，进度已保留。',
        scope: 'private',
        recipients: [event.actor],
      });
    return 'controlled';
  }
  const envelope = recordChatEvent(
    input.state(),
    event,
    input.attention().generation,
  );
  await options.save?.();
  if (options.isCurrent && !options.isCurrent()) return 'stale';
  if (!input.attention().enqueue(event)) {
    envelope.state = 'unknown';
    if (options.onOverflow) await options.onOverflow();
    else await options.save?.();
    return 'full';
  }
  return 'queued';
}
