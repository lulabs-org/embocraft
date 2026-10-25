import type { Model, OpenAICompletionsOptions } from '@earendil-works/pi-ai';
import type { AgentConfig, ModelEndpoint } from '../../contracts/config';
import { ollamaCompletion } from './ollama';

/** Inputs shared by every provider call of one model stream. */
export type ProviderRequest = {
  config: AgentConfig;
  endpoint: ModelEndpoint;
  model: Model<'openai-completions'>;
  request: typeof fetch;
};

/**
 * Wraps the injected transport so every provider call stays redirect-free,
 * Ollama bodies are adapted to its native chat endpoint, and the HTTP status
 * stays observable for redacted error messages.
 */
export function providerFetch(
  input: ProviderRequest,
  onStatus: (status: number) => void,
): typeof fetch {
  const { config, endpoint, model, request } = input;
  return async (url, init) => {
    const response =
      endpoint.type === 'ollama'
        ? await ollamaCompletion(
            url,
            init ?? {},
            request,
            model.contextWindow,
            config.thinking === 'enabled',
          )
        : await request(url, { ...init, redirect: 'error' });
    onStatus(response.status);
    return response;
  };
}

/**
 * Static request options shared by every provider call of one stream.
 *
 * Every value here is a policy decision rather than a provider default: no
 * hidden retries, no prompt cache retention, and local models must answer with
 * a tool call (prose answers are handled by the turn's protocol correction).
 */
export function providerOptions(
  input: ProviderRequest,
  onStatus: (status: number) => void,
): Omit<OpenAICompletionsOptions, 'signal' | 'maxTokens'> {
  const { config, endpoint } = input;
  return {
    apiKey: config.apiKey || 'ollama',
    maxRetries: 0,
    toolChoice: 'required',
    timeoutMs: config.timeoutMs,
    cacheRetention: 'none',
    reasoningEffort:
      endpoint.type === 'deepseek' &&
      config.thinking === 'enabled' &&
      config.reasoningEffort !== 'none'
        ? (config.reasoningEffort as OpenAICompletionsOptions['reasoningEffort'])
        : undefined,
    fetch: providerFetch(input, onStatus),
  };
}
