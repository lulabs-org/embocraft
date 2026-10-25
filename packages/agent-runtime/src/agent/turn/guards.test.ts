import { describe, expect, it } from 'vitest';
import { initialToolState, type ToolState } from '../../contracts/tool-state';
import {
  failBatch,
  type DecisionBoundary,
  toolBlockReason,
  ToolProtocolCorrection,
  turnEnded,
  turnStopped,
} from './guards';

function boundary(
  overrides: {
    state?: Partial<ToolState>;
    signal?: AbortSignal;
    remainingMs?: number;
    shouldYield?: boolean;
  } = {},
): DecisionBoundary {
  return {
    state: { ...initialToolState(), ...overrides.state },
    signal: overrides.signal ?? new AbortController().signal,
    budget: { remainingMs: overrides.remainingMs ?? 1000 },
    shouldYield: () => overrides.shouldYield ?? false,
  };
}

describe('decision boundaries', () => {
  it('keeps a healthy turn running', () => {
    const b = boundary();
    expect(turnStopped(b)).toBe(false);
    expect(turnEnded(b, 'toolUse')).toBe(false);
    expect(toolBlockReason(b, false)).toBeUndefined();
  });

  it.each([
    ['terminal', { terminal: true }],
    ['persistence failure', { persistenceFailed: true }],
  ] as const)('stops the turn on %s', (_name, state) => {
    expect(turnStopped(boundary({ state }))).toBe(true);
  });

  it('stops the turn on abort and when the host asks to yield', () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(turnStopped(boundary({ signal: aborted.signal }))).toBe(true);
    expect(turnStopped(boundary({ shouldYield: true }))).toBe(true);
  });

  it('ends the turn for error and aborted stop reasons only', () => {
    const b = boundary();
    expect(turnEnded(b, 'error')).toBe(true);
    expect(turnEnded(b, 'aborted')).toBe(true);
    expect(turnEnded(b, 'stop')).toBe(false);
  });

  it('treats a truncated message as a whole failed batch', () => {
    const b = boundary();
    expect(toolBlockReason(b, true)).toEqual({
      reason: '模型输出被截断，整批未执行。',
    });
    expect(b.state.skipBatch).toBe(true);
    expect(b.state.hadError).toBe(true);
  });

  it('blocks the remaining calls of a failed batch and terminates the loop', () => {
    const b = boundary({ state: { skipBatch: true } });
    expect(toolBlockReason(b, false)).toEqual({
      reason: '当前批次已停止。',
      terminate: true,
    });
  });

  it.each(['terminal', 'persistence failure', 'abort', 'yield'] as const)(
    'blocks the remaining calls after %s and terminates the loop',
    (kind) => {
      const aborted = new AbortController();
      if (kind === 'abort') aborted.abort();
      const b = boundary({
        state: {
          terminal: kind === 'terminal',
          persistenceFailed: kind === 'persistence failure',
        },
        signal: aborted.signal,
        shouldYield: kind === 'yield',
      });
      expect(toolBlockReason(b, false)).toEqual({
        reason: '当前批次已停止。',
        terminate: true,
      });
    },
  );

  it('blocks the remaining calls once the time budget is exhausted', () => {
    expect(toolBlockReason(boundary({ remainingMs: 0 }), false)).toEqual({
      reason: '执行时间预算已耗尽。',
      terminate: true,
    });
  });

  it('reports truncation before a stopped batch and an exhausted budget', () => {
    const b = boundary({ state: { terminal: true }, remainingMs: 0 });
    expect(toolBlockReason(b, true)).toEqual({
      reason: '模型输出被截断，整批未执行。',
    });
    expect(
      toolBlockReason(
        boundary({ state: { skipBatch: true }, remainingMs: 0 }),
        false,
      ),
    ).toEqual({ reason: '当前批次已停止。', terminate: true });
  });

  it('marks both failure flags together', () => {
    const state = initialToolState();
    failBatch(state);
    expect(state).toMatchObject({ hadError: true, skipBatch: true });
  });
});

describe('tool protocol correction', () => {
  it('is delivered and spent exactly once', () => {
    const correction = new ToolProtocolCorrection();
    expect(correction.available).toBe(true);
    expect(correction.take()).toBe(false);

    correction.request();
    expect(correction.available).toBe(false);
    expect(correction.take()).toBe(true);
    expect(correction.take()).toBe(false);

    correction.request();
    expect(correction.take()).toBe(false);
  });

  it('re-arms for a new turn', () => {
    const correction = new ToolProtocolCorrection();
    correction.request();
    correction.take();
    correction.reset();
    expect(correction.available).toBe(true);
    expect(correction.take()).toBe(false);
  });
});
