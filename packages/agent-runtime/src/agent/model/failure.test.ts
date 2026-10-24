import { describe, expect, it } from 'vitest';
import { AgentRuntimeError } from '../../contracts/errors';
import { streamFailure, thrownFailure } from './failure';

describe('stream failures', () => {
  it('marks a caller abort as aborted', () => {
    expect(streamFailure({ aborted: true, expired: false, status: 0 })).toEqual(
      {
        stopReason: 'aborted',
        message: 'Agent 已停止。',
      },
    );
  });

  it('reports an expired deadline as a timeout', () => {
    expect(
      streamFailure({ aborted: false, expired: true, status: 0 }).message,
    ).toContain('超时');
  });

  it('prefers the deadline over an HTTP status', () => {
    expect(
      streamFailure({ aborted: false, expired: true, status: 500 }).message,
    ).toContain('超时');
  });

  it('includes the HTTP status for provider rejections', () => {
    expect(
      streamFailure({ aborted: false, expired: false, status: 401 }),
    ).toEqual({
      stopReason: 'error',
      message: '模型服务 HTTP 401，请检查模型、工具调用支持及凭据。',
    });
  });

  it('redacts unknown provider failures', () => {
    expect(
      streamFailure({ aborted: false, expired: false, status: 0 }),
    ).toEqual({
      stopReason: 'error',
      message: '模型请求失败，请检查服务及工具调用支持。',
    });
  });

  it('keeps runtime error messages from the thrown path', () => {
    expect(
      thrownFailure(new AgentRuntimeError('已达到任务调用上限。'), false),
    ).toEqual({ stopReason: 'error', message: '已达到任务调用上限。' });
  });

  it('never leaks a raw error from the thrown path', () => {
    expect(
      thrownFailure(new Error('secret upstream body'), false).message,
    ).toBe('模型请求失败，已停止本次处理。');
  });

  it('reports an abort for unknown errors after the signal stopped', () => {
    expect(thrownFailure(new Error('cancelled'), true).message).toBe(
      'Agent 已停止。',
    );
  });
});
