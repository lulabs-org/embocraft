import { AgentRunner, Session } from '@voxel/agent-runtime';
import type { ProviderRuntimePort } from '../providers';
import type { VoiceServiceStore } from '../audio';
import {
  AICharacterOrchestrator,
  type AICharacterDependencies,
} from './services/orchestrator';
import type { ArchivePort } from '../management';
import { readManagementArchive, writeManagementArchive } from '../management';

/** Manager wrapper; production injects a database archive, legacy tests inject files. */
export class AICharacterManager extends AICharacterOrchestrator {
  declare readonly voiceServices: VoiceServiceStore | undefined;

  constructor(
    providers: ProviderRuntimePort & { path?: string },
    serverUrl: string | (() => string),
    dependencies: AICharacterDependencies = {
      session: (url) => new Session(url),
      runner: (_config, provider) =>
        new AgentRunner({ type: provider.type, baseUrl: provider.baseUrl }),
    },
    voiceServices?: VoiceServiceStore,
    archive?: ArchivePort,
  ) {
    const path = providers.path && `${providers.path}.agents.json`;
    if (!archive && !path)
      throw new Error('AICharacterManager requires an archive');
    super(
      providers,
      serverUrl,
      dependencies,
      voiceServices,
      archive ?? {
        load: () => readManagementArchive(path!),
        save: (records) => writeManagementArchive(path!, records),
      },
    );
  }
}
