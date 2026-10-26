import { AgentRunner, Session } from '@voxel/agent-runtime';
import type { FileProviderRepository } from '../providers/persistence/file-repository';
import type { VoiceServiceStore } from '../audio/tts/voice-services';
import {
  AICharacterOrchestrator,
  type AICharacterDependencies,
} from './services/orchestrator';
import type { ArchivePort } from '../../persistence/archive';
import {
  readManagementArchive,
  writeManagementArchive,
} from '../../persistence/archive-file';

/** Compatibility entry point for callers that construct a file-backed manager directly. */
export class AICharacterManager extends AICharacterOrchestrator {
  declare readonly voiceServices: VoiceServiceStore | undefined;

  constructor(
    providers: FileProviderRepository,
    serverUrl: string | (() => string),
    dependencies: AICharacterDependencies = {
      session: (url) => new Session(url),
      runner: (_config, provider) => new AgentRunner(provider),
    },
    voiceServices?: VoiceServiceStore,
    archive?: ArchivePort,
  ) {
    const path = `${providers.path}.agents.json`;
    super(
      providers,
      serverUrl,
      dependencies,
      voiceServices,
      archive ?? {
        load: () => readManagementArchive(path),
        save: (records) => writeManagementArchive(path, records),
      },
    );
  }
}
