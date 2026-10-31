import type { CharacterRecord } from '../../../persistence/archive';

export type { CharacterRecord };

/** Explicit allowlist: adding a display field must never expand the stored document. */
export function characterRecord(source: CharacterRecord): CharacterRecord {
  return structuredClone({
    id: source.id,
    createdAt: source.createdAt,
    status: source.status,
    providerId: source.providerId,
    model: source.model,
    name: source.name,
    goal: source.goal,
    roleDescription: source.roleDescription,
    taskLimitsEnabled: source.taskLimitsEnabled,
    maxTurns: source.maxTurns,
    maxStalledTurns: source.maxStalledTurns,
    tokenBudget: source.tokenBudget,
    taskTimeoutMs: source.taskTimeoutMs,
    intervalMode: source.intervalMode,
    intervalMinMs: source.intervalMinMs,
    intervalMaxMs: source.intervalMaxMs,
    intervalMs: source.intervalMs,
    timeoutMs: source.timeoutMs,
    maxTokens: source.maxTokens,
    permissions: source.permissions,
    skills: source.skills,
    voiceReplies: source.voiceReplies,
    voiceServiceId: source.voiceServiceId,
    thinking: source.thinking,
    reasoningEffort: source.reasoningEffort,
    logEntries: source.logEntries,
    runtime: source.runtime,
    currentRunId: source.currentRunId,
  });
}
