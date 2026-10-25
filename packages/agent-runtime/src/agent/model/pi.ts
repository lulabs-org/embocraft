import type { Model } from '@earendil-works/pi-ai';
import type { AgentConfig, ModelEndpoint } from '../../contracts/config';

export const defaultEndpoint: ModelEndpoint = {
  type: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  jsonMode: true,
  tokenField: 'max_tokens',
};

/** Create a Model definition for the unified agent runner from config and endpoint. */
export function createModel(
  config: AgentConfig,
  endpoint: ModelEndpoint,
): Model<'openai-completions'> {
  return {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: endpoint.type,
    baseUrl: endpoint.baseUrl,
    reasoning: endpoint.type === 'deepseek' || config.thinking === 'enabled',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: config.maxTokens,
    compat: {
      maxTokensField: endpoint.tokenField,
      supportsDeveloperRole: false,
      supportsStore: false,
      ...(endpoint.type === 'deepseek' && {
        thinkingFormat: 'deepseek',
        supportsReasoningEffort: true,
      }),
    },
  };
}
