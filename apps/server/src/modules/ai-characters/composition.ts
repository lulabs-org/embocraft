import { Session } from '@voxel/agent-runtime';
import { DatabaseManagementArchive } from '../../persistence/database-management-archive';
import type { ManagementStore } from '../../persistence/management-store';
import { providerRepository, type ProviderRuntimePort } from '../providers';
import {
  AICharacterOrchestrator,
  type AICharacterDependencies,
} from './application/character-orchestrator';

/** Assemble the character orchestrator with the host's persistence and runtime dependencies. */
export function createAICharacterOrchestrator(
  providers: ProviderRuntimePort = providerRepository,
  serverUrl: string | (() => string) = '',
  archive: ManagementStore = new DatabaseManagementArchive(),
  dependencies: AICharacterDependencies = {
    session: (url) => new Session(url),
    model: (_config, provider) => ({
      endpoint: { type: provider.type, baseUrl: provider.baseUrl },
      request: fetch,
    }),
  },
) {
  return new AICharacterOrchestrator(
    providers,
    serverUrl,
    dependencies,
    archive,
  );
}
