import {
  aiCharacterPermissions,
  type AICharacterSettings,
} from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import type { VoiceServicePort } from '../ports';
import type { Job } from '../runtime/job';
import type { Session } from '@voxel/agent-runtime';

/**
 * Coordinates AI character voice service validation, session binding, and lifecycle integration.
 *
 * Core responsibilities:
 * 1. Configuration validation: Ensures a valid and available voice service is configured when voice replies are enabled.
 * 2. Room session binding: Associates the character's active room session ID with the designated TTS voice service to control muting and speech output.
 * 3. Room state synchronization: Dispatches session protocol messages (`agent.voice`) to toggle the character's speech generation state on the server.
 * 4. Cleanup protection: Guards against accidental deletion of voice services currently in use by active characters.
 */
export class CharacterVoiceCoordinator {
  constructor(readonly voiceServices?: VoiceServicePort) {}

  /**
   * Validates the voice configuration for an AI character.
   * When voice replies are enabled, a registered voice service ID is required.
   *
   * @param settings The character settings to validate
   * @throws {AppError} When voice service is missing or not registered
   */
  checkVoice(settings: AICharacterSettings) {
    if (settings.voiceReplies && !settings.voiceServiceId)
      throw new AppError('请先选择语音服务。');
    if (settings.voiceServiceId)
      this.voiceServices?.get(settings.voiceServiceId);
  }

  /**
   * Binds the character's active room session to the target TTS voice service.
   * - If voice replies are enabled and the character has chat permissions, binds to the configured voice service ID (or 'local-default').
   * - If voice replies are disabled or chat permission is absent, unbinds/mutes by passing an empty string.
   *
   * @param job The runtime character job entity
   */
  bindVoice(job: Job) {
    if (job.view.sessionId) {
      this.voiceServices?.bind(
        job.view.sessionId,
        job.view.voiceReplies && aiCharacterPermissions(job.view).chat
          ? job.view.voiceServiceId || 'local-default'
          : '',
      );
    }
  }

  /**
   * Retrieves the human-readable display name of a voice service by its ID.
   *
   * @param voiceServiceId The voice service ID
   * @returns The display name of the service, or undefined if not found or unspecified
   */
  getServiceName(voiceServiceId?: string): string | undefined {
    return this.voiceServices?.list().find((s) => s.id === voiceServiceId)
      ?.name;
  }

  /**
   * Sends an `agent.voice` request to the active room session to synchronize the voice reply toggle state.
   *
   * @param session Active room session
   * @param enabled Whether voice replies are enabled
   * @returns Response indicating operation success (`ok: boolean`)
   */
  async syncSessionVoice(
    session: Session,
    enabled: boolean,
  ): Promise<{ ok: boolean }> {
    return session.request('agent.voice', { enabled });
  }

  /**
   * Safely deletes a voice service after verifying that no active or updating agents are currently using it.
   *
   * @param id ID of the voice service to delete
   * @param inUse Callback returning true if the service is still referenced by any agent
   * @throws {AppError} If voice services are uninitialized or the service is currently in use
   */
  async removeVoiceService(id: string, inUse: () => boolean) {
    if (!this.voiceServices) throw new AppError('语音服务未就绪。', 503);
    await this.voiceServices.remove(id, inUse);
  }
}
