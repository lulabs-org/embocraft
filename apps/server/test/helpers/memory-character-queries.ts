import { runtimeView } from '@voxel/agent-runtime';
import { AppError } from '../../src/core/errors/app-error';
import type { ArchivePort } from '../../src/persistence/archive';
import type { CharacterQueryPort } from '../../src/modules/ai-characters';
import type { ProviderRepository } from '../../src/modules/providers';
import type { VoiceServiceStore } from '../../src/modules/tts';

/** Read the saved test archive, never the manager's live jobs or snapshot cache. */
export function memoryCharacterQueries(
  archive: ArchivePort,
  providers: ProviderRepository,
  voices: VoiceServiceStore,
): CharacterQueryPort {
  const list: CharacterQueryPort['list'] = async () => {
    const saved = await archive.load();
    return (saved?.characters ?? [])
      .map((record) => {
        const { runtime, currentRunId, logEntries, ...config } = record;
        const state = runtime ? runtimeView(runtime) : undefined;
        const run = saved?.runs.find((run) => run.id === currentRunId);
        const queuedTasks = (saved?.runs ?? [])
          .filter(
            (run) => run.characterId === record.id && run.status === 'queued',
          )
          .sort((a, b) => a.scheduledAt - b.scheduledAt)
          .map((run) => ({
            id: run.id,
            goal: run.snapshot.goal,
            scheduledAt: run.scheduledAt,
            coalescedTriggers: run.coalescedTriggers ?? 0,
          }));
        return {
          ...config,
          providerName: providers.getRuntime(record.providerId).name,
          voiceServiceId: record.voiceServiceId ?? '',
          voiceServiceName: voices
            .list()
            .find((voice) => voice.id === record.voiceServiceId)?.name,
          task: state?.task,
          taskIdentity: state?.identity ?? null,
          taskExecution: run
            ? {
                runId: run.id,
                limits: run.snapshot.limits,
                source: run.source,
                action: state?.action,
              }
            : undefined,
          ...(queuedTasks.length ? { queuedTasks } : {}),
          usage: state?.usage,
          lastResponse: state?.lastResponse,
          taskRequiresReassignment: state?.requiresReassignment ?? false,
        };
      })
      .reverse();
  };
  return {
    list,
    async get(id) {
      const character = (await list()).find((character) => character.id === id);
      if (!character) throw new AppError('AI 角色 不存在。', 404);
      return character;
    },
    async logs(id, limit, offset) {
      const saved = await archive.load();
      const character = saved?.characters.find(
        (character) => character.id === id,
      );
      if (!character) throw new AppError('AI 角色 不存在。', 404);
      return {
        entries: [...character.logEntries]
          .reverse()
          .slice(offset, offset + limit),
        total: character.logEntries.length,
      };
    },
  };
}
