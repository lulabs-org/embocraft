import type { RuntimeState } from '@voxel/agent-runtime';
import type { AICharacterSettings, AICharacterView } from '@voxel/shared';

export type CharacterRecord = AICharacterSettings &
  Pick<AICharacterView, 'id' | 'createdAt' | 'status' | 'logEntries'> & {
    runtime?: RuntimeState;
    currentRunId?: string;
  };

/** Select persisted settings, never a spread of the public view. */
export function characterSettings(
  view: AICharacterSettings,
): AICharacterSettings {
  return {
    providerId: view.providerId,
    name: view.name,
    model: view.model,
    goal: view.goal,
    roleDescription: view.roleDescription,
    taskLimitsEnabled: view.taskLimitsEnabled,
    maxTurns: view.maxTurns,
    maxStalledTurns: view.maxStalledTurns,
    tokenBudget: view.tokenBudget,
    taskTimeoutMs: view.taskTimeoutMs,
    intervalMode: view.intervalMode,
    intervalMinMs: view.intervalMinMs,
    intervalMaxMs: view.intervalMaxMs,
    intervalMs: view.intervalMs,
    timeoutMs: view.timeoutMs,
    maxTokens: view.maxTokens,
    permissions: view.permissions,
    skills: view.skills,
    voiceReplies: view.voiceReplies,
    voiceServiceId: view.voiceServiceId,
    thinking: view.thinking,
    reasoningEffort: view.reasoningEffort,
  };
}
