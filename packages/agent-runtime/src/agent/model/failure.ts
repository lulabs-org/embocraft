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
  if (input.aborted) {
    return { stopReason: 'aborted', message: 'Agent 已停止。' };
  }

  if (input.expired) {
    return { stopReason: 'error', message: '模型请求超时，已停止本次处理。' };
  }

  if (input.status >= 400) {
    return {
      stopReason: 'error',
      message: `模型服务 HTTP ${input.status}，请检查模型、工具调用支持及凭据。`,
    };
  }

  return {
    stopReason: 'error',
    message: '模型请求失败，请检查服务及工具调用支持。',
  };
}

/**
 * Maps an exception thrown while composing or relaying the request. Provider
 * errors are replaced by a redacted message; the raw cause never reaches the
 * transcript.
 */
export function thrownFailure(error: unknown, aborted: boolean): StreamFailure {
  if (error instanceof AgentRuntimeError) {
    return { stopReason: 'error', message: error.message };
  }

  if (aborted) {
    return { stopReason: 'error', message: 'Agent 已停止。' };
  }

  return {
    stopReason: 'error',
    message: '模型请求失败，已停止本次处理。',
  };
}
