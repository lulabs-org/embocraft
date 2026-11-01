import { aiCharacterPermissions, type WorldEvent } from '@voxel/shared';
import type { Session } from '@voxel/agent-runtime';
import type { Job } from './character-job';
import type { ExecutionContext } from './execution-context';

/** Host lifecycle guards and ledger transaction hooks; intake policy belongs to the runtime. */
export function handleWorldEvent(
  event: WorldEvent,
  job: Job,
  session: Session,
  ctx: ExecutionContext,
  log: (message: string) => void,
) {
  let controlling = false;
  void job.runtime
    .receive(event, {
      save: ctx.save,
      isCurrent: () => job.session === session && !ctx.closing(),
      onOverflow: () => {
        log('消息队列已满，当前消息未接收。');
        ctx.persist();
      },
      control: ({ operation, lease, commandId, message }) => {
        controlling = true;
        return ctx.controlMessage(
          job.view.id,
          operation,
          lease,
          commandId,
          message,
        );
      },
      controlCommitted: ctx.persist,
      replyToControl: aiCharacterPermissions(job.view).chat,
    })
    .then((result) => {
      if (result === 'queued' && ['idle', 'failed'].includes(job.view.status)) {
        log('收到玩家消息，处理一次唤醒。');
        ctx.wake(job);
      }
    })
    .catch(() => {
      // Control failures retain their existing silent receipt handling.
      if (!controlling) log('消息保存失败，未启动执行。');
    });
}
