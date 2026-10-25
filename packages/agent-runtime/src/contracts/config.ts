import type { AICharacterSettings, ProviderType } from '@voxel/shared';

export type AgentConfig = Omit<AICharacterSettings, 'providerId'> & {
  apiKey: string;
};

export type ModelEndpoint = {
  type: ProviderType;
  baseUrl: string;
};
