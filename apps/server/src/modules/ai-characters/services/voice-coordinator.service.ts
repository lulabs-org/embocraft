import {
  aiCharacterPermissions,
  type AICharacterSettings,
} from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import { domainEvents } from '../../../core/events/domain-events';
import { ttsService, withVoiceServiceReference } from '../../tts';
import type { Job } from './character-job';
import type { Session } from '@voxel/agent-runtime';

/**
 * Coordinates AI character voice service validation, session binding, and lifecycle integration.
 */
export class CharacterVoiceCoordinator {
  async checkVoice(settings: AICharacterSettings) {
    if (settings.voiceReplies && !settings.voiceServiceId)
      throw new AppError('请先选择语音服务。');
    if (settings.voiceServiceId) await ttsService.get(settings.voiceServiceId);
  }

  async bindVoice(job: Job, settings: AICharacterSettings = job.view) {
    const sessionId = job.view.sessionId;
    if (!sessionId) return;
    const serviceId =
      settings.voiceReplies && aiCharacterPermissions(settings).chat
        ? settings.voiceServiceId || 'local-default'
        : '';
    await withVoiceServiceReference(serviceId, async () => {
      if (serviceId) await ttsService.get(serviceId);
      if (job.view.sessionId !== sessionId) return;
      domainEvents.emit('agent.voice.bound', { sessionId, serviceId });
    });
  }

  unbindVoice(sessionId: string) {
    domainEvents.emit('agent.voice.unbound', { sessionId });
  }

  async syncSessionVoice(
    session: Session,
    enabled: boolean,
  ): Promise<{ ok: boolean }> {
    return session.request('agent.voice', { enabled });
  }
}
