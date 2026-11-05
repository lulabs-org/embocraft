import { Session } from '@voxel/agent-runtime';

import { DatabaseManagementArchive } from '../../../persistence/database-management-archive';
import type { ArchivePort } from '../../../persistence/management-archive';
import { providerRepository, type ProviderRuntimePort } from '../../providers';
import {
  AICharacterOrchestrator,
  type AICharacterDependencies,
} from './orchestrator.service';

/** Manager wrapper with explicit persistence supplied by the host. */
export class AICharacterManager extends AICharacterOrchestrator {
  constructor(
    providers: ProviderRuntimePort = providerRepository,
    serverUrl: string | (() => string) = '',
    archive: ArchivePort = new DatabaseManagementArchive(),
    dependencies: AICharacterDependencies = {
      session: (url) => new Session(url),
      model: (_config, provider) => ({
        endpoint: { type: provider.type, baseUrl: provider.baseUrl },
        request: fetch,
      }),
    },
  ) {
    super(providers, serverUrl, dependencies, archive);
  }
}
