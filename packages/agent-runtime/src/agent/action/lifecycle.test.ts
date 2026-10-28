import { expect, it, vi } from 'vitest';
import { testAgentConfig } from '../../../../../tests/support/agent-config';
import { emptyState, type RuntimeState } from '../../contracts/state';
import { initialToolState } from '../../contracts/tool-state';
import type { AgentSession } from '../../world/session/port';
import { TaskService } from '../task/service';
import { newTask } from '../task/state';
import {
  launchBackgroundWorldAction,
  markActiveActionRunning,
} from './lifecycle';
import { ActionRuntime, actionWakeDelay } from './runtime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const memory = emptyState();
  memory.execution.task.current = newTask('goal');
  memory.execution.task.current.privateTo = 'owner';
  const service = new TaskService(memory);
  const lease = service.lease();
  const controller = new AbortController();
  const session = {
    observe: vi.fn<AgentSession['observe']>(),
    move: vi.fn<AgentSession['move']>(),
    request: vi.fn(async () => {
      throw Error('Unexpected world request');
    }),
  };
  const options = {
    memory,
    session,
    signal: controller.signal,
    config: testAgentConfig(),
  };
  const runtime = new ActionRuntime(options);
  const state = initialToolState();
  const snapshots: RuntimeState[] = [];
  const save = vi.fn(async () => {
    snapshots.push(structuredClone(memory));
  });
  const host = {
    service,
    memory,
    state,
    activeSignal: controller.signal,
    save,
    launch: runtime.launch.bind(runtime),
  };
  return {
    memory,
    service,
    lease,
    controller,
    session,
    options,
    runtime,
    state,
    snapshots,
    save,
    host,
  };
}

it('keeps the action slot occupied until its result and event are durably saved', async () => {
  const f = fixture();
  const work = deferred<unknown>();
  const savingResult = deferred<void>();
  const releaseSave = deferred<void>();
  f.save.mockImplementationOnce(async () => {
    f.snapshots.push(structuredClone(f.memory));
  });
  f.save.mockImplementationOnce(async () => {
    savingResult.resolve();
    await releaseSave.promise;
    f.snapshots.push(structuredClone(f.memory));
  });
  expect(
    await launchBackgroundWorldAction(f.host, {
      id: 'build-1',
      name: 'build',
      lease: f.lease,
      controller: new AbortController(),
      work: work.promise,
    }),
  ).toEqual({ actionId: 'build-1', status: 'running' });
  expect(f.snapshots[0].execution.effects.activeAction?.status).toBe('running');
  expect(f.state.terminal).toBe(true);
  work.resolve({ batchId: 'internal', ok: true });
  await savingResult.promise;
  expect(f.runtime.isRunning).toBe(true);
  expect(f.runtime.isSettled).toBe(false);
  releaseSave.resolve();
  await f.runtime.complete();
  expect(f.runtime.isRunning).toBe(false);
  const saved = f.snapshots[1];
  expect(saved.execution.effects.activeAction).toMatchObject({
    id: 'build-1',
    status: 'completed',
    result: { content: [{ type: 'text', text: '{"ok":true}' }], details: {} },
  });
  expect(saved.character.inbox?.events).toEqual([
    expect.objectContaining({
      id: 'action:build-1',
      kind: 'action_result',
      state: 'pending',
      audience: 'owner',
      taskId: f.lease.id,
      revision: f.lease.revision,
    }),
  ]);
});

it('ignores a late result after revision, including its serialization and result event', async () => {
  const f = fixture();
  const work = deferred<unknown>();
  await launchBackgroundWorldAction(f.host, {
    id: 'old',
    name: 'goto',
    lease: f.lease,
    controller: new AbortController(),
    work: work.promise,
  });
  f.service.command(
    { type: 'revise', goal: 'replacement' },
    { kind: 'operator' },
    f.options.config,
  );
  markActiveActionRunning(f.memory, 'new', 'goto', f.service.lease());
  const replacement = structuredClone(f.memory);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  work.resolve(cyclic);
  await f.runtime.complete();
  expect(f.memory).toEqual(replacement);
});

it.each([false, true])(
  'drains cancellation and preserves unknown only on host interruption (%s)',
  async (hostInterrupted) => {
    const f = fixture();
    const controller = new AbortController();
    const work = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(Error('stopped')),
        { once: true },
      );
    });
    await launchBackgroundWorldAction(f.host, {
      id: 'navigation',
      name: 'goto',
      lease: f.lease,
      controller,
      work,
    });
    if (hostInterrupted) f.controller.abort();
    await f.runtime.cleanup();
    expect(controller.signal.aborted).toBe(true);
    expect(f.runtime.isRunning).toBe(false);
    expect(f.snapshots.at(-1)?.execution.effects.activeAction?.status).toBe(
      hostInterrupted ? 'unknown' : 'failed',
    );
    expect(f.memory.character.inbox?.events).toHaveLength(1);
  },
);

function following(f: ReturnType<typeof fixture>) {
  f.memory.execution.effects.follow = {
    action: { type: 'follow', playerId: 'human', distance: 2 },
    taskStartedAt: f.memory.execution.task.current!.startedAt,
    pursuing: true,
  };
  markActiveActionRunning(f.memory, 'follow-1', 'follow', f.lease);
}

it('does not advance saved actions while paused or denied by the task budget', async () => {
  const f = fixture();
  following(f);
  expect(actionWakeDelay(f.memory)).toBe(100);
  const budget = vi.fn(async () => false);
  expect(await f.runtime.advance(budget)).toBe('stop');
  f.memory.execution.task.current!.status = 'paused';
  expect(await f.runtime.advance(budget)).toBe('idle');
  expect(budget).toHaveBeenCalledTimes(1);
  expect(f.session.observe).not.toHaveBeenCalled();
  expect(f.session.move).not.toHaveBeenCalled();
});

it('publishes a failed continuation once and requests a recovery decision', async () => {
  const f = fixture();
  following(f);
  f.options.config.permissions.move = false;
  expect(await f.runtime.advance(async () => true)).toBe('resume');
  expect(f.memory.execution.task.current?.status).toBe('running');
  expect(f.memory.execution.effects.follow).toBeUndefined();
  expect(actionWakeDelay(f.memory)).toBeUndefined();
  expect(f.memory.execution.effects.activeAction?.status).toBe('failed');
  expect(f.session.observe).not.toHaveBeenCalled();
  expect(f.session.move).toHaveBeenCalledWith(0, 0, false);
  expect(f.memory.character.inbox?.events).toEqual([
    expect.objectContaining({
      id: `action:follow-1:${f.lease.revision}`,
      actionId: 'follow-1',
      audience: 'owner',
      revision: f.lease.revision,
      kind: 'action_result',
      detail: f.memory.execution.task.current?.reason,
    }),
  ]);
  expect(await f.runtime.advance(async () => true)).toBe('idle');
  expect(f.memory.character.inbox?.events).toHaveLength(1);
});
