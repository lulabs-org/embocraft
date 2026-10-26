import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type OpenAICompletionsOptions,
} from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AgentConfig, ModelEndpoint } from '../../contracts/config';
import { mergeSignals, withDeadline } from '../../kernel/abort';
import {
  estimateTokens,
  RequestCharge,
  type RequestAccounting,
} from './charge';
import { streamFailure, thrownFailure, type StreamFailure } from './failure';
import { createModel } from './pi';

/** Everything one character turn needs to make provider requests. */
export type ModelStreamOptions = {
  config: AgentConfig;
  endpoint: ModelEndpoint;
  budget: RequestAccounting;
  /** Turn-level stop signal, composed with the loop signal and a deadline. */
  signal: AbortSignal;
  /** Injected transport for tests; real runs use the global fetch. */
  request?: typeof fetch;
  /**
   * Persists request admission before dispatch. Called after the call is charged
   * and before the request leaves, so a crash cannot replay it for free.
   */
  persistAdmission?: () => Promise<void>;
};

type StreamFnArgs = Parameters<StreamFn>;

type RelayRequest = ModelStreamOptions & {
  context: StreamFnArgs[1];
  callerSignal?: AbortSignal;
  output: AssistantMessageEventStream;
};

/**
 * Streams one provider request into Pi's decision loop. The request model is
 * rebuilt from the turn config so mutable Pi state cannot change its identity.
 */
export function streamModel(
  options: ModelStreamOptions,
  context: StreamFnArgs[1],
  callerSignal?: AbortSignal,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void relay({ ...options, context, callerSignal, output });
  return output;
}

/** Runs one model call and relays its events until a terminal event or failure. */
async function relay(request: RelayRequest) {
  const { config, endpoint, budget, output } = request;
  const model = createModel(config, request.endpoint);
  const deadline = withDeadline(
    mergeSignals(request.signal, request.callerSignal),
    Math.min(config.timeoutMs, budget.remainingMs),
    'model_timeout',
  );
  const combined = deadline.signal;
  const charge = new RequestCharge(
    budget,
    estimateTokens(request.context, config.maxTokens),
  );
  const fail = (failure: StreamFailure) =>
    output.push({
      type: 'error',
      reason: failure.stopReason,
      error: errorMessage(model, failure),
    });
  let status = 0;
  try {
    combined.throwIfAborted();
    // Charge and persist admission before dispatch: a crash between these lines
    // must leave the request accounted for rather than replaying it for free.
    const maxTokens = charge.begin();
    await request.persistAdmission?.();
    combined.throwIfAborted();
    const source = stream(model, request.context, {
      ...providerOptions(
        config,
        endpoint,
        request.request ?? fetch,
        (next) => (status = next),
      ),
      signal: combined,
      maxTokens,
    });
    for await (const event of source) {
      if (event.type === 'done' || event.type === 'error') {
        charge.settleUsage(
          (event.type === 'done' ? event.message : event.error).usage
            .totalTokens,
        );
        if (event.type === 'error' || combined.aborted)
          fail(
            streamFailure({
              aborted: request.signal.aborted,
              expired: deadline.expired,
              status,
            }),
          );
        else output.push(event);
      } else if (!combined.aborted) output.push(event);
    }
  } catch (error) {
    charge.settleUnknown();
    fail(thrownFailure(error, request.signal.aborted));
  } finally {
    deadline.clear();
    output.end();
  }
}

const EMPTY_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Terminal error message carrying model identity and failure details. */
function errorMessage(
  model: Model<'openai-completions'>,
  failure: StreamFailure,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: failure.stopReason,
    errorMessage: failure.message,
    timestamp: Date.now(),
  };
}

/**
 * Static request options shared by every provider call of one stream.
 *
 * Every value here is a policy decision rather than a provider default: no
 * hidden retries, no prompt cache retention, and tool calls are required.
 */
export function providerOptions(
  config: AgentConfig,
  endpoint: ModelEndpoint,
  request: typeof fetch,
  onStatus: (status: number) => void,
): Omit<OpenAICompletionsOptions, 'signal' | 'maxTokens'> {
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
    fetch: async (url, init) => {
      const response = await request(url, { ...init, redirect: 'error' });
      onStatus(response.status);
      return response;
    },
  };
}
