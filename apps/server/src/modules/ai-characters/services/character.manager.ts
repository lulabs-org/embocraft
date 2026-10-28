import { AgentRunner, Session } from '@voxel/agent-runtime';
import type { ArchivePort } from '../../../persistence/archive';
import type { VoiceServiceStore } from '../../audio';
import type { ProviderRuntimePort } from '../../providers';
import {
  AICharacterOrchestrator,
  type AICharacterDependencies,
} from './orchestrator.service';

/** Manager wrapper with explicit persistence supplied by the host. */
export class AICharacterManager extends AICharacterOrchestrator {
  declare readonly voiceServices: VoiceServiceStore | undefined;

  constructor(
    providers: ProviderRuntimePort,
    serverUrl: string | (() => string),
    archive: ArchivePort,
    dependencies: AICharacterDependencies = {
      session: (url) => new Session(url),
      runner: (_config, provider) =>
        new AgentRunner({ type: provider.type, baseUrl: provider.baseUrl }),
    },
    voiceServices?: VoiceServiceStore,
  ) {
    super(providers, serverUrl, dependencies, voiceServices, archive);
  }
}
