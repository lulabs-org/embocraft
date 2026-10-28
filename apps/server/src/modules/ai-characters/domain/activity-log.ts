import { AI_CHARACTER_LOG_LIMIT, type AICharacterView } from '@voxel/shared';

type LogView = Pick<AICharacterView, 'logEntries'>;

const MAX_TIME = 8.64e15;

/** 校验并清洗反序列化后的角色日志条目，限制在最大条数范围内 */
export function restoreAICharacterLogs(entries: unknown): Required<LogView> {
  const logEntries = (Array.isArray(entries) ? entries : [])
    .flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const { time, text } = entry as { time?: unknown; text?: unknown };
      if (typeof text !== 'string' || !text) return [];
      const normalized =
        typeof time === 'number' &&
        Number.isFinite(time) &&
        time >= 0 &&
        time <= MAX_TIME
          ? time
          : null;
      return [{ time: normalized, text }];
    })
    .slice(-AI_CHARACTER_LOG_LIMIT);
  return { logEntries };
}

/** 向角色的内存日志数组追加一条记录并维持上限 */
export function appendAICharacterLog(
  view: LogView,
  message: string,
  now = Date.now(),
) {
  const previous = restoreAICharacterLogs(view.logEntries);
  view.logEntries = [
    ...previous.logEntries,
    { time: now, text: message },
  ].slice(-AI_CHARACTER_LOG_LIMIT);
}
