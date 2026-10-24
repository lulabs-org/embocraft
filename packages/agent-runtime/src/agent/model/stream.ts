import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AgentConfig, ModelEndpoint } from '../../contracts/config';
import { mergeSignals, withDeadline } from '../../kernel/abort';
import { estimateTokens, RequestCharge } from './charge';
import { streamFailure, thrownFailure, type StreamFailure } from './failure';
import { createModel } from './pi';
import type { RequestAccounting } from './port';
import { providerOptions } from './provider';

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
 * Streams one provider request into the decision loop.
 *
 * No shared auth store, hidden retries, redirects, or raw provider errors in
 * transcripts. The composed deadline is the only timer that cancels a call, and
 * the request is charged exactly once whether it succeeds, fails or is aborted.
 */
export function createModelStream(options: ModelStreamOptions): StreamFn {
  // The loop's model is derived from the same config on every run, so this layer
  // rebuilds it: request identity must follow the turn config, not mutable agent state.
  return (_model, context, callerOptions) => {
    const output = createAssistantMessageEventStream();
    void relay({
      ...options,
      context,
      callerSignal: callerOptions?.signal,
      output,
    });
    return output;
  };
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
      error: {
        ...emptyMessage(model),
        stopReason: failure.stopReason,
        errorMessage: failure.message,
      },
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
        {
          config,
          endpoint,
          model,
          request: request.request ?? fetch,
        },
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

/** Placeholder message that carries the model identity for terminal error events. */
function emptyMessage(model: Model<'openai-completions'>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    timestamp: Date.now(),
  };
}
