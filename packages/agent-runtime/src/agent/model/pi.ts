import type { Model } from '@earendil-works/pi-ai';
import type { AgentConfig, ModelEndpoint } from '../../contracts/config';

export const defaultEndpoint: ModelEndpoint = {
  type: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
};

const MODEL_DEFAULTS = {
  api: 'openai-completions' as const,
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
};

/**
 * Automatically determine the token limit parameter field:
 * - OpenAI reasoning models (o1, o3, o4) reject `max_tokens` and require `max_completion_tokens`.
 * - Other models / endpoints default to `max_tokens`.
 */
export function resolveMaxTokensField(
  model: string,
): 'max_tokens' | 'max_completion_tokens' {
  const normalized = model.toLowerCase();
  if (
    /(^|\/|\b)(o[134](-preview|-mini)?)(\b|$)/.test(normalized) ||
    /(^|\/)o[134](-|$)/.test(normalized)
  ) {
    return 'max_completion_tokens';
  }
  return 'max_tokens';
}

/** Create a Model definition for the unified agent runner from config and endpoint. */
export function createModel(
  config: AgentConfig,
  endpoint: ModelEndpoint,
): Model<'openai-completions'> {
  return {
    ...MODEL_DEFAULTS,
    id: config.model,
    name: config.model,
    provider: endpoint.type,
    baseUrl: endpoint.baseUrl,
    reasoning: endpoint.type === 'deepseek' || config.thinking === 'enabled',
    maxTokens: config.maxTokens,
    ...(endpoint.type !== 'deepseek' && {
      compat: {
        maxTokensField: resolveMaxTokensField(config.model),
        supportsDeveloperRole: false,
        supportsStore: false,
      },
    }),
  };
}
