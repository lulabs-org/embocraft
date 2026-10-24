import type { AgentConfig, ModelEndpoint } from '../../contracts/config';

/**
 * Applies provider-specific request-body policy before the payload is sent.
 *
 * DeepSeek reads its thinking controls from the body; other endpoints must not
 * receive them, so the fields are only written for that provider. The payload
 * is mutated in place because Pi hands us the final provider body.
 */
export function providerPayload(
  config: AgentConfig,
  endpoint: ModelEndpoint,
  payload: unknown,
): Record<string, unknown> {
  const body = payload as Record<string, unknown>;
  if (endpoint.type === 'deepseek') {
    body.thinking = { type: config.thinking };
    if (config.thinking === 'enabled')
      body.reasoning_effort = config.reasoningEffort;
    else delete body.reasoning_effort;
  }
  return body;
}
