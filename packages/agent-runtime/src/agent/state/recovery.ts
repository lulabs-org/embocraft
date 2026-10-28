import type { RuntimeState } from '../../contracts/state';
import { restoreBatchHistory } from '../task/state';
import { restoreCheckpoint } from '../turn/checkpoint';

/** Connection-bound private audiences cannot be reused after a process restart. */
function expireConnection(state: RuntimeState) {
  if (state.execution.effects.activeAction?.status === 'running')
    state.execution.effects.activeAction.status = 'unknown';
  for (const event of state.character.inbox?.events ?? [])
    if (event.kind === 'chat' || event.state === 'processing')
      event.state = 'unknown';
  if (state.character.conversation.exchanges) {
    const publicHistory = state.character.conversation.exchanges.public;
    state.character.conversation.exchanges = publicHistory
      ? { public: publicHistory }
      : {};
  }
}

/** Preserve the current-character restart policy without issuing any world effects. */
export function recoverCharacter(state: RuntimeState) {
  expireConnection(state);
  state.execution.effects.previous = restoreBatchHistory(
    state.execution.effects.previous,
  );
  restoreCheckpoint(state);
  const task = state.execution.task.current;
  if (task && ['running', 'waiting'].includes(task.status)) {
    task.status = 'paused';
    task.reason = '服务重启，任务进度已保留，请手动继续。';
  }
  if (task && !task.privateTo) delete task.owner;
  if (task?.privateTo && !['completed', 'cancelled'].includes(task.status)) {
    state.execution.conversation.audienceExpired = true;
    task.status = 'needs_input';
    task.reason = '服务重启后原私聊会话已失效，请重新通过聊天发起。';
  }
}

/** The ledger supplies its lifecycle flags; the runtime owns checkpoint/audience repair. */
export function recoverHistoricalExecution(
  state: RuntimeState,
  options: { unfinished: boolean; running: boolean },
) {
  restoreCheckpoint(state);
  expireConnection(state);
  if (state.execution.effects.previous)
    state.execution.effects.previous = restoreBatchHistory(
      state.execution.effects.previous,
    );
  const task = state.execution.task.current;
  const audienceExpired = !!task?.privateTo && options.unfinished;
  if (audienceExpired && task) {
    state.execution.conversation.audienceExpired = true;
    task.status = 'needs_input';
    task.reason = '原私聊会话已失效，请重新通过聊天发起。';
  } else if (options.running && task) {
    task.status = 'paused';
    task.reason = '服务重启，进度保留，请手动继续。';
  }
  return { audienceExpired };
}
