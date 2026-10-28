import { describe, expect, it, vi } from 'vitest';
import type { ChatData, WorldEvent } from '@voxel/shared';
import type { AgentConfig } from '../contracts/config';
import { emptyState } from '../contracts/state';
import { newTask } from '../agent/task/state';
import { createAgentRuntime } from './runtime';
import { MemorySession } from '../testing/memory-session';
import { testAgentConfig } from '../../../../tests/support/agent-config';
import type { RunOptions } from '../agent/turn/turn';
import type { RuntimeMessageControl } from './ports';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const chat = (seq: number, actor = 'alice'): WorldEvent => ({
  seq,
  at: 1_700_000_000_000 + seq,
  type: 'chat',
  actor,
  actorKind: 'human',
  data: {
    scope: 'private',
    kind: 'text',
    text: 'hello',
    name: 'Alice',
    recipients: ['ai'],
  },
});

describe('AgentRuntime facade', () => {
  it('does not queue before persistence or deliver an old connection message after reconnect', async () => {
    const saved = deferred();
    const runtime = createAgentRuntime({
      session: new MemorySession(),
      selfId: 'ai',
    });
    const pending = runtime.receive(chat(1), { save: () => saved.promise });
    expect(runtime.snapshot().inbox?.events).toHaveLength(1);
    expect(runtime.pendingMessages).toBe(false);
    runtime.connect(new MemorySession(), 'ai');
    saved.resolve();
    await expect(pending).resolves.toBe('stale');
    expect(runtime.pendingMessages).toBe(false);
    // A new connection has its own deduplication generation.
    await expect(runtime.receive(chat(1))).resolves.toBe('queued');
  });

  it('retains an audit but never queues a message whose persistence failed', async () => {
    const runtime = createAgentRuntime({
      session: new MemorySession(),
      selfId: 'ai',
    });
    await expect(
      runtime.receive(chat(1), {
        save: async () => {
          throw Error('disk');
        },
      }),
    ).rejects.toThrow('disk');
    expect(runtime.pendingMessages).toBe(false);
    expect(runtime.snapshot().inbox?.events[0].state).toBe('pending');
  });

  it('marks overflow unknown and uses the host persistence hook only after the initial save', async () => {
    const runtime = createAgentRuntime({
      session: new MemorySession(),
      selfId: 'ai',
    });
    for (let seq = 1; seq <= 8; seq++) await runtime.submit(chat(seq));
    const order: string[] = [];
    const result = await runtime.receive(chat(9), {
      save: () => {
        order.push('save');
      },
      onOverflow: () => {
        expect(runtime.snapshot().inbox?.events.at(-1)?.state).toBe('unknown');
        order.push('overflow');
      },
    });
    expect(result).toBe('full');
    expect(order).toEqual(['save', 'overflow']);
  });

  it('routes authorized controls through host interruption and leaves unauthorized words as conversation', async () => {
    const state = {
      ...emptyState(),
      task: { current: newTask('private work', 'alice', 'alice') },
    };
    const runtime = createAgentRuntime({
      session: new MemorySession(),
      selfId: 'ai',
      state,
    });
    const control = vi.fn(
      async ({ operation, message }: RuntimeMessageControl) => {
        runtime.stageControl(
          { type: operation },
          { kind: 'player', message },
          testAgentConfig(),
        );
      },
    );
    const controlMessage = (seq: number, actor: string) => {
      const event = chat(seq, actor);
      return { ...event, data: { ...(event.data as ChatData), text: '暂停' } };
    };
    await expect(
      runtime.receive(controlMessage(1, 'bob'), { control }),
    ).resolves.toBe('queued');
    expect(control).not.toHaveBeenCalled();
    expect(runtime.view().task?.status).toBe('running');
    await expect(
      runtime.receive(controlMessage(2, 'alice'), { control }),
    ).resolves.toBe('controlled');
    expect(control).toHaveBeenCalledTimes(1);
    expect(runtime.view().task?.status).toBe('paused');
    expect(runtime.snapshot().inbox?.events.at(-1)).toMatchObject({
      kind: 'control',
      actor: 'alice',
      state: 'done',
    });
  });

  it('owns one execution slot, rejects state swaps while active, and settles cleanup before control', async () => {
    const cleanup = deferred();
    const order: string[] = [];
    const config = testAgentConfig();
    const state = { ...emptyState(), task: { current: newTask('work') } };
    const runtime = createAgentRuntime({
      session: new MemorySession(),
      state,
      store: {
        save: () => {
          order.push('save');
        },
      },
      runner: {
        run: async (options: RunOptions) => {
          await new Promise<void>((resolve) =>
            options.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
          order.push('abort');
          await cleanup.promise;
          order.push('cleanup');
        },
      },
    });
    const running = runtime.run(config, {
      signal: new AbortController().signal,
    });
    await expect(
      runtime.run(config, { signal: new AbortController().signal }),
    ).rejects.toThrow('已在运行');
    expect(() => runtime.restore(emptyState())).toThrow('已在运行');
    expect(() =>
      runtime.stageControl({ type: 'pause' }, { kind: 'operator' }, config),
    ).toThrow('已在运行');
    const controlling = runtime.control(
      { type: 'pause' },
      { kind: 'operator' },
      config,
    );
    await vi.waitFor(() => expect(order).toEqual(['abort']));
    expect(runtime.view().task?.status).toBe('running');
    cleanup.resolve();
    await Promise.all([running, controlling]);
    expect(order).toEqual(['abort', 'cleanup', 'save']);
    expect(runtime.view().task?.status).toBe('paused');
  });

  it('rejects unauthorized or invalid control before interrupting current work or clearing messages', async () => {
    const released = deferred();
    let signal!: AbortSignal;
    const runtime = createAgentRuntime({
      session: new MemorySession(),
      selfId: 'ai',
      state: {
        ...emptyState(),
        task: { current: newTask('private', 'alice', 'alice') },
      },
      runner: {
        run: async (options: RunOptions) => {
          signal = options.signal;
          await released.promise;
        },
      },
    });
    await runtime.submit(chat(1));
    const running = runtime.run(testAgentConfig(), {
      signal: new AbortController().signal,
    });
    try {
      await expect(
        runtime.control(
          { type: 'pause' },
          { kind: 'player', message: chat(2, 'bob') },
          testAgentConfig(),
        ),
      ).rejects.toThrow('仅任务发起者');
      await expect(
        runtime.control(
          { type: 'revise', goal: '' },
          { kind: 'operator' },
          testAgentConfig(),
        ),
      ).rejects.toThrow('目标无效');
      expect(signal.aborted).toBe(false);
      expect(runtime.pendingMessages).toBe(true);
    } finally {
      released.resolve();
      await running;
    }
  });

  it('records, persists and queues an addressed chat exactly once', async () => {
    const store = { save: vi.fn(async () => {}) };
    const runtime = createAgentRuntime({
      session: new MemorySession(),
      selfId: 'ai',
      store,
    });

    await expect(runtime.submit(chat(1))).resolves.toBe(true);
    expect(runtime.attention.pending).toBe(true);
    expect(runtime.state.inbox?.events).toHaveLength(1);
    expect(runtime.state.inbox?.events[0]).toMatchObject({
      id: `chat:${runtime.attention.generation}:alice:1`,
      kind: 'chat',
      state: 'pending',
      audience: 'alice',
    });
    expect(store.save).toHaveBeenCalledTimes(1);

    await expect(runtime.submit(chat(1))).resolves.toBe(false);
    expect(runtime.state.inbox?.events).toHaveLength(1);
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it('ignores chat that is not addressed to this character', async () => {
    const runtime = createAgentRuntime({
      session: new MemorySession(),
      selfId: 'ai',
    });
    const other = {
      ...chat(1),
      data: {
        scope: 'private',
        kind: 'text',
        text: 'hello',
        name: 'Bob',
        recipients: ['someone-else'],
      },
    };
    await expect(runtime.submit(other)).resolves.toBe(false);
    expect(runtime.state.inbox).toBeUndefined();
  });

  it('applies authorized operator control and exposes a copy-only snapshot', async () => {
    const state = {
      ...emptyState(),
      task: { current: newTask('walk') },
    };
    const runtime = createAgentRuntime({
      session: new MemorySession(),
      selfId: 'ai',
      state,
    });

    await runtime.control(
      { type: 'pause' },
      { kind: 'operator' },
      {} as AgentConfig,
    );
    expect(runtime.state.task.current?.status).toBe('paused');

    const snapshot = runtime.snapshot();
    expect(snapshot).not.toBe(runtime.state);
    snapshot.task.current!.status = 'completed';
    expect(runtime.state.task.current?.status).toBe('paused');
  });
});
