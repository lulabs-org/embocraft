import type { AICharacterSettings } from '@voxel/shared';
import type { PlanService } from '../../tasks';
import { restoreAICharacterLogs } from '../domain/activity-log';
import { validateAICharacter } from '../domain/validation';
import { AppError } from '../../../core/errors/app-error';
import type { ProviderRuntimePort } from '../../providers';
import type { CharacterRecord } from './record';
import { createCharacterJob, type Job } from '../services/job';
import { restoreTaskExecution, restoreTaskMemory } from '../../tasks';
import { executionState } from '../services/task-adapter';

export function restoreAICharacterJob(
  view: CharacterRecord,
  providers: ProviderRuntimePort,
  checkVoice: (settings: AICharacterSettings) => void,
  ledger: PlanService,
): { job: Job; voiceWarning?: string; shouldAutoJoin: boolean } {
  const provider = providers.getRuntime(view.providerId);
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

  const job = createCharacterJob(
    {
      view: {
        ...settings,
        id: view.id,
        createdAt: view.createdAt,
        providerName: provider.name,
        status: 'stopped',
        ...restoreAICharacterLogs(view.logEntries),
      },
      abort: new AbortController(),
      ledger,
      currentRunId: view.currentRunId,
    },
    restoreTaskMemory(view.runtime),
  );

  restoreTaskExecution(executionState(job));

  const shouldAutoJoin = ['idle', 'running', 'joining', 'failed'].includes(
    view.status,
  );

  return { job, voiceWarning: voiceWarning || undefined, shouldAutoJoin };
}
