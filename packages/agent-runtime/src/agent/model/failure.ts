import { AgentRuntimeError } from '../../contracts/errors';

/** Terminal failure surfaced to the decision loop as an assistant error event. */
export type StreamFailure = {
  stopReason: 'error' | 'aborted';
  message: string;
};

/**
 * Maps a provider stream that terminated with an error event. Only the caller
 * aborting marks the response as aborted; a deadline or HTTP failure stays an
 * error so the turn policy can classify it.
 */
export function streamFailure(input: {
  aborted: boolean;
  expired: boolean;
  status: number;
}): StreamFailure {
  return {
    stopReason: input.aborted ? 'aborted' : 'error',
    message: input.aborted
      ? 'Agent 已停止。'
      : input.expired
        ? '模型请求超时，已停止本次处理。'
        : input.status >= 400
          ? `模型服务 HTTP ${input.status}，请检查模型、工具调用支持及凭据。`
          : '模型请求失败，请检查服务及工具调用支持。',
  };
}

/**
 * Maps an exception thrown while composing or relaying the request. Provider
 * errors are replaced by a redacted message; the raw cause never reaches the
 * transcript.
 */
export function thrownFailure(error: unknown, aborted: boolean): StreamFailure {
  return {
    stopReason: 'error',
    message:
      error instanceof AgentRuntimeError
        ? error.message
        : aborted
          ? 'Agent 已停止。'
          : '模型请求失败，已停止本次处理。',
  };
}
