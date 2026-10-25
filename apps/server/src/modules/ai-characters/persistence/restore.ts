import type { AICharacterSettings } from '@voxel/shared';
import { AgentAttention } from '@voxel/agent-runtime';
import type { PlanService } from '../../tasks/persistence/service';
import {
  migrateLegacyLogs,
  restoreAICharacterLogs,
} from '../domain/activity-log';
import { validateAICharacter } from '../domain/validation';
import { AppError } from '../../../common/errors';
import type { ProviderQueryPort } from '../../providers/ports';
import type { CharacterRecord, Job } from '../domain/types';
import {
  restoreTaskExecution,
  restoreTaskMemory,
} from '../../tasks/persistence/restore';
import { executionState } from '../domain/task-adapter';

export function restoreAICharacterJob(
  view: CharacterRecord,
  providers: ProviderQueryPort,
  checkVoice: (settings: AICharacterSettings) => void,
  ledger: PlanService,
): { job: Job; voiceWarning?: string; shouldAutoJoin: boolean } {
  const provider = providers.get(view.providerId);
  const settings = validateAICharacter(view, provider);
  let voiceWarning = '';
  try {
    checkVoice(settings);
  } catch {
    settings.voiceReplies = false;
    settings.voiceServiceId = '';
    voiceWarning = '原语音服务不可用，已保留文字回复；请重新选择语音服务。';
  }
  if (typeof view.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(view.id))
    throw new AppError('Agent 标识无效。', 500);

  const job: Job = {
    view: {
      ...settings,
      id: view.id,
      createdAt: view.createdAt,
      providerName: provider.name,
      status: 'stopped',
      ...restoreAICharacterLogs(
        Array.isArray(view.logEntries)
          ? view.logEntries
          : migrateLegacyLogs(
              // Legacy archives persisted two parallel arrays before `logEntries`.
              (view as { logs?: unknown }).logs,
              (view as { logTimes?: unknown }).logTimes,
            ),
      ),
    },
    abort: new AbortController(),
    memory: restoreTaskMemory(view.runtime, view.task, settings.goal),
    attention: new AgentAttention(),
    ledger,
    currentRunId: view.currentRunId,
  };

  restoreTaskExecution(
    executionState(job),
    !view.currentRunId && !!view.runtime?.task.current,
  );

  const shouldAutoJoin = ['idle', 'running', 'joining', 'failed'].includes(
    view.status,
  );

  return { job, voiceWarning: voiceWarning || undefined, shouldAutoJoin };
}
