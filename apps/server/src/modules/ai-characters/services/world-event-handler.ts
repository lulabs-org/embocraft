import {
  aiCharacterPermissions,
  type ChatData,
  type WorldEvent,
} from '@voxel/shared';
import {
  parseControlCommand,
  recordChatEvent,
  recordEvent,
  TaskService,
  type Session,
} from '@voxel/agent-runtime';
import type { Job } from './job';
import type { ExecutionContext } from './execution-context';

/**
 * 监听并处理游戏房间世界事件（WorldEvent）：
 * 1. 尝试解析并执行任务控制指令（暂停/取消）；
 * 2. 若非控制指令或鉴权不通过，则将消息作为普通聊天记录排入注意力队列并视情况唤醒。
 */
export function handleWorldEvent(
  event: WorldEvent,
  job: Job,
  session: Session,
  ctx: ExecutionContext,
  log: (message: string) => void,
) {
  const enqueueMessage = () => {
    const envelope = recordChatEvent(
      job.memory,
      event,
      job.attention.generation,
    );
    void ctx
      .save()
      .then(() => {
        if (job.session !== session || ctx.closing()) return;
        if (!job.attention.enqueue(event)) {
          envelope.state = 'unknown';
          log('消息队列已满，当前消息未接收。');
          ctx.persist();
          return;
        }
        if (['idle', 'failed'].includes(job.view.status)) {
          log('收到玩家消息，处理一次唤醒。');
          ctx.wake(job);
        }
      })
      .catch(() => log('消息保存失败，未启动执行。'));
  };

  const command = parseControlCommand((event.data as ChatData).text);
  const task = job.memory.task.current;

  if (task && command) {
    try {
      new TaskService(job.memory).authorize({
        kind: 'player',
        message: event,
      });
    } catch {
      enqueueMessage();
      return;
    }
    void ctx
      .controlMessage(
        job.view.id,
        command,
        new TaskService(job.memory).lease(),
        `world-${job.attention.generation}-${event.seq}`,
        event,
      )
      .then(() => {
        recordEvent(job.memory, {
          id: `control:${job.attention.generation}:${event.seq}`,
          kind: 'control',
          state: 'done',
          at: event.at,
          audience: event.actor,
          actor: event.actor,
          detail: command,
        });
        ctx.persist();
        return aiCharacterPermissions(job.view).chat
          ? session.request('chat', {
              text:
                command === 'cancel'
                  ? '任务已取消，我会留在这里待命。'
                  : '任务已暂停，进度已保留。',
              scope: 'private',
              recipients: [event.actor],
            })
          : undefined;
      })
      .catch(() => {});
    return;
  }

  enqueueMessage();
}
