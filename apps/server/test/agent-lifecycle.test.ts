import { startTask, controlRun } from '../../../tests/support/managed-tasks';
import { type Planner } from '../../../tests/support/decision-fixture';
import { fixtureRunnerFactory } from '../../../tests/support/decision-fixture';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AICharacterManager } from '../src/modules/ai-characters';
import {
  FileProviderRepository,
  bootstrapProviders,
} from '../src/modules/providers';
import { VoiceServiceStore } from '../src/modules/audio/persistence/voice-service-store';
import {
  AgentRuntimeError,
  type Session,
  type Observation,
} from '@voxel/agent-runtime';

import type { WorldEvent } from '@voxel/shared';
let dir: string,
  store: FileProviderRepository,
  manager: AICharacterManager | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-life-'));
  store = new FileProviderRepository(join(dir, 'providers.json'));
  await bootstrapProviders(store, { DEEPSEEK_API_KEY: 'fixture' });
});
afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await rm(dir, { recursive: true, force: true });
});
function fakeSession(wait = Promise.resolve()) {
  let open = false;
  const leaves: (() => void)[] = [];
  const session = {
    onEvent: undefined as ((event: WorldEvent) => void) | undefined,
    room: {
      sessionId: 'player-1',
      onMessage: vi.fn(),
      onLeave: (cb: () => void) => leaves.push(cb),
      connection: { close: () => {} },
    },
    join: vi.fn(async () => {
      await wait;
      open = true;
    }),
    close: vi.fn(async () => {
      if (open) {
        open = false;
        leaves.forEach((cb) => cb());
      }
    }),
    move: vi.fn(),
    observe: vi.fn(
      async () =>
        ({ self: { id: 'player-1' }, events: [] }) as unknown as Observation,
    ),
    request: vi.fn(async (_type: string, _payload?: unknown) => ({ ok: true })),
  };
  return session;
}
function setup(
  s: ReturnType<typeof fakeSession>,
  decide: Planner['decide'] = vi.fn(async () => ({
    actions: [{ type: 'wait' as const }],
    task: {
      intent: 'continue' as const,
      status: 'completed' as const,
      summary: '测试决策',
    },
  })),
  voices?: VoiceServiceStore,
) {
  manager = new AICharacterManager(
    store,
    'ws://fixture',
    {
      session: () => s as unknown as Session,
      runner: fixtureRunnerFactory(() => ({ decide })),
    },
    voices,
  );
  return manager;
}

it.each([
  '{invalid-json',
  JSON.stringify({ version: 99, agents: [{ id: 'keep-me' }] }),
  JSON.stringify({
    version: 1,
    agents: [{ id: 'keep-me', providerId: 'missing-provider', name: '保留' }],
    plans: [],
    runs: [],
    requests: {},
  }),
])(
  'does not overwrite an unreadable or unrestorable archive during shutdown',
  async (original) => {
    const path = `${store.path}.agents.json`;
    await writeFile(path, original);
    const m = setup(fakeSession());
    await expect(m.load()).rejects.toThrow();
    expect(() => m.assertWritable()).toThrow('存档恢复失败');
    await m.close();
    expect(await readFile(path, 'utf8')).toBe(original);
  },
);
async function createWithTask(
  m: AICharacterManager,
  value: Record<string, unknown>,
) {
  const { goal, ...profile } = value;
  const created = m.create(profile);
  await m.settled(created.id);
  await m.tasks.createTaskPlan(created.id, {
    name: String(goal).slice(0, 80),
    goal,
    timing: { kind: 'immediate' },
    timeZone: 'UTC',
    limits: {
      maxTurns: value.maxTurns ?? 100,
      tokenBudget: value.tokenBudget ?? 50000,
      taskTimeoutMs: value.taskTimeoutMs ?? 900000,
    },
  });
  return m.list().find((agent) => agent.id === created.id)!;
}
const settings = {
  voiceServiceId: 'local-default',
  providerId: 'deepseek',
  name: 'Reusable',
  goal: 'Wait',
  maxTurns: 1,
};
it('saves task heartbeat independently without resetting or resuming progress', async () => {
  const decide = vi.fn<Planner['decide']>(async () => ({
    actions: [{ type: 'wait' }],
    task: { intent: 'continue', status: 'needs_input', summary: '地基已完成' },
  }));
  const m = setup(fakeSession(), decide);
  const created = await createWithTask(m, { ...settings, maxTurns: 30 });
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  await controlRun(m, created.id, 'pause');
  const before = m.list()[0];
  const schedule = {
    intervalMode: 'random',
    intervalMs: 3000,
    intervalMinMs: 5000,
    intervalMaxMs: 9000,
  };
  const saved = await m.update(created.id, schedule);
  expect(saved).toMatchObject(schedule);
  expect(saved.task).toEqual(before.task);
  expect(saved.usage).toEqual(before.usage);
  expect(saved.logEntries).toEqual(before.logEntries);
  await expect(m.update(created.id, { intervalMinMs: 10000 })).rejects.toThrow(
    '下限',
  );
  expect(m.list()[0]).toMatchObject(schedule);
  // A subsequent role-only save must retain the independently saved heartbeat.
  await m.update(created.id, { roleDescription: '负责营地建造' });
  expect(m.list()[0]).toMatchObject(schedule);
  await m.close();
  const restored = setup(fakeSession(), decide);
  await restored.load();
  expect(restored.list()[0]).toMatchObject({
    ...schedule,
    task: JSON.parse(JSON.stringify(before.task)),
    usage: before.usage,
  });
  expect(decide).toHaveBeenCalledTimes(1);
});
it('protects a new voice binding while an Agent update is waiting for the world', async () => {
  const voices = new VoiceServiceStore(join(dir, 'voices.json'));
  await voices.load();
  const next = await voices.save({ name: 'Next', type: 'piper' });
  const session = fakeSession();
  const m = setup(session, undefined, voices);
  const job = await createWithTask(m, { ...settings, voiceReplies: true });
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  let release!: () => void;
  session.request.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true };
  });
  const updating = m.update(job.id, {
    voiceServiceId: next.id,
    voiceReplies: false,
  });
  await expect(m.removeVoiceService(next.id)).rejects.toThrow();
  release();
  await updating;
  expect(m.list()[0].voiceServiceId).toBe(next.id);
  await expect(m.removeVoiceService(next.id)).rejects.toThrow();
  await m.update(job.id, { voiceServiceId: '', voiceReplies: false });
  await m.removeVoiceService(next.id);
});
it('restores a missing voice service as text-only without model calls', async () => {
  const voices = new VoiceServiceStore(join(dir, 'voices.json'));
  await voices.load();
  const m = setup(fakeSession(), undefined, voices);
  await createWithTask(m, { ...settings, voiceReplies: true });
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  await m.close();
  await voices.remove('local-default', () => false);
  const decide = vi.fn();
  const restored = setup(fakeSession(), decide, voices);
  await restored.load();
  expect(restored.list()[0].voiceReplies).toBe(false);
  expect(restored.list()[0].voiceServiceId).toBe('');
  expect(
    restored
      .list()[0]
      .logEntries.map((entry) => entry.text)
      .join('\n'),
  ).toContain('原语音服务不可用');
  expect(decide).not.toHaveBeenCalled();
});
it('toggles voice during inference without restarting the agent or making another model call', async () => {
  let release!: () => void;
  const s = fakeSession();
  const decide = vi.fn(async () => {
    await new Promise<void>((resolve) => (release = resolve));
    return {
      actions: [{ type: 'wait' as const }],
      task: {
        intent: 'continue' as const,
        status: 'completed' as const,
        summary: '测试决策',
      },
    };
  });
  const m = setup(s, decide),
    job = await createWithTask(m, settings);
  await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
  await expect(m.setVoice(job.id, { enabled: 'yes' })).rejects.toThrow();
  expect((await m.setVoice(job.id, { enabled: true })).voiceReplies).toBe(true);
  expect((await m.setVoice(job.id, { enabled: false })).voiceReplies).toBe(
    false,
  );
  expect(s.request).toHaveBeenLastCalledWith('agent.voice', { enabled: false });
  expect(s.join).toHaveBeenCalledTimes(1);
  expect(s.close).not.toHaveBeenCalled();
  expect(decide).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
});
it('updates saved settings without inference, protects identity, validates inputs and persists', async () => {
  const s = fakeSession(),
    decide = vi.fn(
      async (): Promise<
        import('../../../tests/support/decision-contracts').AgentDecision
      > => ({
        actions: [{ type: 'wait' as const }],
        task: {
          intent: 'continue' as const,
          status: 'completed' as const,
          summary: '测试决策',
        },
      }),
    );
  const m = setup(s, decide),
    job = await createWithTask(m, settings);
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  await expect(
    m.update(job.id, {
      intervalMode: 'random',
      intervalMinMs: 8000,
      intervalMaxMs: 4000,
    }),
  ).rejects.toThrow('下限');
  const updated = await m.update(job.id, {
    maxTurns: 50,
    intervalMode: 'random',
    intervalMinMs: 4000,
    intervalMaxMs: 8000,
    maxTokens: 1024,
    allowEdits: true,
    voiceReplies: true,
    id: 'forged',
    status: 'running',
  });
  expect(updated).toMatchObject({
    id: job.id,
    status: 'idle',
    sessionId: 'player-1',
    maxTurns: 50,
    maxTokens: 1024,
    allowEdits: true,
    voiceReplies: true,
  });
  expect(s.request).toHaveBeenCalledWith('agent.voice', { enabled: true });
  expect(decide).toHaveBeenCalledTimes(1);
  expect(s.join).toHaveBeenCalledTimes(1);
  await m.close();
  const restored = setup(s, decide);
  await restored.load();
  expect(restored.list()[0]).toMatchObject({
    id: job.id,
    maxTurns: 50,
    intervalMinMs: 4000,
    intervalMaxMs: 8000,
    maxTokens: 1024,
  });
});
it('task errors leave a joined character online until explicitly closed', async () => {
  const s = fakeSession(),
    decide = vi
      .fn()
      .mockRejectedValue(new AgentRuntimeError('fixture failure', true));
  const m = setup(s, decide),
    job = await createWithTask(m, settings);
  await vi.waitFor(() => expect(m.list()[0]?.status).toBe('failed'));
  expect(s.close).not.toHaveBeenCalled();
  expect(m.list()[0]?.sessionId).toBe('player-1');
  m.stop(job.id);
  await vi.waitFor(() => expect(m.list()[0]?.status).toBe('stopped'));
  expect(s.close).toHaveBeenCalled();
});
it('closing while join is pending cannot leave an orphan player or start inference', async () => {
  let resolve!: () => void;
  const s = fakeSession(new Promise<void>((r) => (resolve = r))),
    decide = vi.fn(
      async (): Promise<
        import('../../../tests/support/decision-contracts').AgentDecision
      > => ({
        actions: [{ type: 'wait' as const }],
        task: {
          intent: 'continue' as const,
          status: 'completed' as const,
          summary: '测试决策',
        },
      }),
    );
  const m = setup(s, decide),
    job = m.create({ ...settings, goal: '' });
  await vi.waitFor(() => expect(s.join).toHaveBeenCalled());
  m.stop(job.id);
  resolve();
  await vi.waitFor(() => expect(m.list()[0]?.status).toBe('stopped'));
  expect(m.list()[0]?.sessionId).toBeUndefined();
  expect(decide).not.toHaveBeenCalled();
  expect(s.close.mock.calls.length).toBeGreaterThanOrEqual(2);
});
it('unexpected disconnect releases identity and allows rejoining the same saved agent', async () => {
  const s = fakeSession(),
    m = setup(s),
    job = await createWithTask(m, settings);
  await vi.waitFor(() => expect(m.list()[0]?.status).toBe('idle'));
  await s.close();
  expect(m.list()[0]?.status).toBe('failed');
  expect(m.list()[0]?.sessionId).toBeUndefined();
  m.join(job.id);
  await m.settled(job.id);
  await startTask(m, job.id, { goal: 'New goal' });
  await vi.waitFor(() => expect(m.list()[0]?.status).toBe('idle'));
  expect(m.list()[0]).toMatchObject({
    id: job.id,
    goal: 'New goal',
    sessionId: 'player-1',
  });
  expect(s.join).toHaveBeenCalledTimes(2);
});

it('human mentions wake an idle agent once and queue during inference without concurrent calls', async () => {
  const s = fakeSession();
  let release!: () => void;
  const decide = vi.fn(async () => ({
    actions: [{ type: 'wait' as const }],
    task: {
      intent: 'continue' as const,
      status: 'completed' as const,
      summary: '测试决策',
    },
  }));
  const m = setup(s, decide),
    job = await createWithTask(m, settings);
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  const mention = (seq: number, actorKind = 'human'): WorldEvent => ({
    seq,
    actorKind,
    actor: 'person',
    type: 'chat',
    at: Date.now(),
    data: {
      scope: 'public',
      recipients: ['player-1'],
      text: '换个地方',
      kind: 'text',
      name: 'Person',
    },
  });
  s.onEvent!(mention(1, 'ai-agent'));
  expect(decide).toHaveBeenCalledTimes(1);
  decide.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      actions: [{ type: 'wait' }],
      task: {
        intent: 'continue' as const,
        status: 'completed' as const,
        summary: '测试决策',
      },
    };
  });
  s.onEvent!(mention(2));
  await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
  s.onEvent!(mention(2));
  s.onEvent!(mention(3));
  expect(decide).toHaveBeenCalledTimes(2);
  release();
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  expect(decide).toHaveBeenCalledTimes(3);
  expect(s.join).toHaveBeenCalledTimes(1);
  expect(s.close).not.toHaveBeenCalled();
  m.stop(job.id);
  await vi.waitFor(() => expect(m.list()[0].status).toBe('stopped'));
  s.onEvent!(mention(4));
  expect(decide).toHaveBeenCalledTimes(3);
});

it('pause, resume and cancel keep identity and retain task progress across restart', async () => {
  const s = fakeSession();
  const decide = vi.fn(async () => ({
    actions: [{ type: 'wait' as const }],
    task: {
      intent: 'continue' as const,
      status: 'running' as const,
      summary: '地基已规划',
    },
  }));
  const m = setup(s, decide),
    job = await createWithTask(m, {
      ...settings,
      maxTurns: 30,
      intervalMs: 60000,
    });
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  await controlRun(m, job.id, 'pause');
  expect(m.list()[0]).toMatchObject({
    sessionId: 'player-1',
    task: { status: 'paused', summary: '地基已规划', calls: 1 },
    usage: { calls: 1 },
  });
  await controlRun(m, job.id, 'resume');
  await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  await controlRun(m, job.id, 'pause');
  await m.close();
  const restored = setup(s, decide);
  await restored.load();
  expect(decide).toHaveBeenCalledTimes(2);
  expect(restored.list()[0]).toMatchObject({
    task: { status: 'paused', summary: '地基已规划', calls: 2 },
    usage: { calls: 2 },
  });
  await controlRun(restored, job.id, 'cancel');
  expect(restored.list()[0]).toMatchObject({
    sessionId: 'player-1',
    task: { status: 'cancelled' },
  });
});

it('pausing pending inference drops late edits and does not close the character', async () => {
  const s = fakeSession();
  let release!: () => void;
  const decide = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      actions: [
        { type: 'edit' as const, x: 2, y: 3, z: 1, material: 'wood' as const },
      ],
      task: {
        intent: 'continue' as const,
        status: 'running' as const,
        summary: '测试决策',
      },
    };
  });
  const m = setup(s, decide),
    job = await createWithTask(m, {
      ...settings,
      maxTurns: 30,
      allowEdits: true,
    });
  await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
  const paused = controlRun(m, job.id, 'pause');
  release();
  await paused;
  expect(s.request.mock.calls.some((c) => (c as unknown[])[0] === 'edit')).toBe(
    false,
  );
  expect(s.close).not.toHaveBeenCalled();
  expect(m.list()[0].task?.status).toBe('paused');
});

it('expired private task audiences cannot be resumed after server restart', async () => {
  const s = fakeSession(),
    decide = vi.fn(
      async (): Promise<
        import('../../../tests/support/decision-contracts').AgentDecision
      > => ({
        actions: [{ type: 'wait' as const }],
        task: {
          intent: 'continue' as const,
          status: 'completed' as const,
          summary: '测试决策',
        },
      }),
    );
  const m = setup(s, decide),
    job = await createWithTask(m, settings);
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  decide.mockResolvedValueOnce({
    actions: [{ type: 'wait' }],
    task: {
      intent: 'task',
      status: 'waiting',
      waitFor: 'world',
      goal: 'private goal',
      summary: 'waiting',
    },
  });
  s.onEvent!({
    seq: 1,
    at: Date.now(),
    type: 'chat',
    actor: 'private-person',
    actorKind: 'human',
    data: {
      scope: 'private',
      recipients: ['player-1'],
      kind: 'text',
      text: 'secret task',
      name: 'Person',
    },
  });
  await vi.waitFor(() =>
    expect(m.list()[0].task?.privateTo).toBe('private-person'),
  );
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  await m.close();
  const restored = setup(s, decide);
  await restored.load();
  expect(restored.list()[0].task?.status).toBe('needs_input');
  await expect(controlRun(restored, job.id, 'resume')).rejects.toThrow(
    '私聊会话已失效',
  );
  expect(decide).toHaveBeenCalledTimes(2);
});

it('keeps the current chat-assigned goal consistent through editing, persistence and rerunning', async () => {
  const s = fakeSession();
  const decide = vi.fn<Planner['decide']>(async () => ({
    actions: [{ type: 'wait' }],
    task: {
      intent: 'continue' as const,
      status: 'completed' as const,
      summary: '测试决策',
    },
  }));
  const m = setup(s, decide),
    job = await createWithTask(m, settings);
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  decide.mockResolvedValueOnce({
    actions: [{ type: 'wait' }],
    task: {
      intent: 'task',
      status: 'completed',
      goal: 'Build a new house',
      summary: 'House verified',
    },
  });
  s.onEvent!({
    seq: 1,
    at: Date.now(),
    type: 'chat',
    actor: 'person',
    actorKind: 'human',
    data: {
      scope: 'public',
      recipients: ['player-1'],
      kind: 'text',
      text: 'Build a new house',
      name: 'Person',
    },
  });
  await vi.waitFor(() =>
    expect(m.list()[0].task?.goal).toBe('Build a new house'),
  );
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  const before = m.list()[0];
  expect(before.goal).toBe(before.task?.goal);
  const updated = await m.update(job.id, {
    maxTokens: 1024,
  });
  expect(updated.task).toEqual(before.task);
  const partial = await m.update(job.id, { maxTokens: 2048 });
  expect(partial.goal).toBe('Build a new house');
  expect(partial.task).toEqual(before.task);
  await m.close();
  const restored = setup(s, decide);
  await restored.load();
  expect(restored.list()[0].goal).toBe('Build a new house');
  await startTask(restored, job.id, { goal: restored.list()[0].task!.goal });
  await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(3));
  expect(decide.mock.calls[2][1]).toMatchObject({
    task: { goal: 'Build a new house' },
  });
  await vi.waitFor(() => expect(restored.list()[0].status).toBe('idle'));
  const preserved = restored.list()[0];
  await expect(
    restored.update(job.id, { goal: 'Plant a garden' }),
  ).rejects.toThrow('Tasks');
  expect(restored.list()[0]).toEqual(preserved);
});

it('an online agent with a failed task still accepts a new human mention without automatic retries', async () => {
  const s = fakeSession();
  const decide = vi
    .fn<Planner['decide']>()
    .mockRejectedValueOnce(new AgentRuntimeError('fixture failure', true));
  const m = setup(s, decide),
    job = await createWithTask(m, { ...settings, maxTurns: 30 });
  await vi.waitFor(() => expect(m.list()[0].status).toBe('failed'));
  expect(decide).toHaveBeenCalledTimes(1);
  decide.mockResolvedValueOnce({
    actions: [{ type: 'chat', text: '我还在，任务已暂停。' }],
    task: { intent: 'reply', status: 'completed', summary: '已回复' },
  });
  s.onEvent!({
    seq: 1,
    at: Date.now(),
    type: 'chat',
    actor: 'human',
    actorKind: 'human',
    data: {
      scope: 'public',
      recipients: ['player-1'],
      kind: 'text',
      text: '还在吗',
      name: 'Person',
    },
  });
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  expect(decide).toHaveBeenCalledTimes(2);
  expect(m.list()[0]).toMatchObject({
    id: job.id,
    sessionId: 'player-1',
    task: { status: 'blocked', calls: 1 },
  });
  expect(s.join).toHaveBeenCalledTimes(1);
  expect(s.request).toHaveBeenCalledWith('chat', {
    text: '我还在，任务已暂停。',
  });
});

it('creates and restores a standby character with no task or automatic model calls', async () => {
  const session = fakeSession(),
    decide = vi.fn();
  const m = setup(session, decide);
  const created = m.create({
    ...settings,
    goal: '',

    roleDescription: '你是一名建筑师，负责建造房屋。',
  });
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  expect(m.list()[0]).toMatchObject({
    id: created.id,
    goal: '',
    sessionId: 'player-1',
    roleDescription: '你是一名建筑师，负责建造房屋。',
    allowEdits: false,
  });
  expect(m.list()[0].task).toBeUndefined();
  expect(decide).not.toHaveBeenCalled();
  expect(m.currentRunId(created.id)).toBeUndefined();
  expect(() => m.join(created.id)).toThrow('已在线');
  await m.update(created.id, {
    name: 'Renamed standby',
    model: 'deepseek-chat',
    allowEdits: true,
    roleDescription: '你是一名建筑师，施工前先确认玩家需求。',
  });
  expect(m.list()[0].task).toBeUndefined();
  await m.close();
  const restored = setup(fakeSession(), decide);
  await restored.load();
  expect(restored.list()[0]).toMatchObject({
    id: created.id,
    name: 'Renamed standby',
    status: 'idle',
    roleDescription: '你是一名建筑师，施工前先确认玩家需求。',
  });
  expect(restored.list()[0].task).toBeUndefined();
  expect(decide).not.toHaveBeenCalled();
  await restored.update(created.id, { roleDescription: '' });
  expect(restored.list()[0].roleDescription).toBe('');
  expect(restored.list()[0].task).toBeUndefined();
});

it('keeps task progress and usage when only the role description changes', async () => {
  const decide = vi.fn<Planner['decide']>(async () => ({
    actions: [{ type: 'wait' }],
    task: { intent: 'continue', status: 'running', summary: '地基已完成' },
  }));
  const m = setup(fakeSession(), decide);
  const created = await createWithTask(m, {
    ...settings,
    maxTurns: 30,
    intervalMs: 60000,
  });
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  await controlRun(m, created.id, 'pause');
  const task = structuredClone(m.list()[0].task);
  const usage = structuredClone(m.list()[0].usage);
  await m.update(created.id, {
    roleDescription: '你是一名建筑师，先检查已有施工进度。',
  });
  expect(m.list()[0].task).toEqual(task);
  expect(m.list()[0].usage).toEqual(usage);
  expect(decide).toHaveBeenCalledTimes(1);
});

it('joining a stopped character preserves the task without executing or resetting its budget', async () => {
  const session = fakeSession();
  const decide = vi.fn<Planner['decide']>(async () => ({
    actions: [{ type: 'wait' }],
    task: { intent: 'continue', status: 'running', summary: 'Half done' },
  }));
  const m = setup(session, decide);
  const created = await createWithTask(m, {
    ...settings,
    maxTurns: 30,
    intervalMs: 60000,
  });
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  m.stop(created.id);
  await vi.waitFor(() => expect(m.list()[0].status).toBe('stopped'));
  expect(m.list()[0].task).toMatchObject({
    status: 'paused',
    summary: 'Half done',
    calls: 1,
  });
  m.join(created.id);
  expect(() => m.join(created.id)).toThrow('已在线');
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  expect(decide).toHaveBeenCalledTimes(1);
  expect(m.list()[0].task).toMatchObject({
    status: 'paused',
    summary: 'Half done',
    calls: 1,
  });
  await startTask(m, created.id, { goal: 'A fresh task' });
  expect(m.list()[0].queuedTasks).toHaveLength(1);
  expect(m.list()[0].task?.status).toBe('paused');
  await controlRun(m, created.id, 'cancel');
  await m.tasks.dispatchDue();
  await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  expect(m.list()[0].task?.goal).toBe('A fresh task');
});

it('standby creation rejects task input and still enforces online capacity', async () => {
  const m = setup(fakeSession(), vi.fn());
  expect(() => m.create(settings)).toThrow('Tasks');
  expect(() => m.create({ ...settings, goal: '', startTask: true })).toThrow(
    'Tasks',
  );
  expect(() => m.create({ ...settings, goal: '', joinWorld: 'no' })).toThrow(
    '开关',
  );
  for (let i = 0; i < 4; i++)
    m.create({ ...settings, name: `Standby ${i}`, goal: '' });
  expect(() => m.create({ ...settings, goal: '' })).toThrow('最多同时在线');
});

it('retains capability settings and construction progress across edits, reload and resume', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const s = fakeSession();
  const decide = vi.fn<Planner['decide']>(async () => ({
    actions: [{ type: 'wait' }],
    task: {
      intent: 'continue',
      status: 'needs_input',
      summary: '地基已完成，等待确认',
    },
  }));
  const m = setup(s, decide);
  const created = await createWithTask(m, {
    ...settings,
    maxTurns: 30,
    allowEdits: true,
    intervalMs: 60000,
  });
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  await m.close();
  const path = `${store.path}.agents.json`;
  const archive = JSON.parse(await readFile(path, 'utf8'));
  const block = { x: 10, y: 3, z: 1, material: 'wood' };
  const unfinishedBuild = {
    action: { type: 'build', blocks: [block] },
    result: {
      ok: false,
      total: 2,
      completed: 1,
      skipped: 0,
      remaining: [block],
      uncertain: [block],
      failures: [],
      note: '等待确认',
    },
  };
  archive.characters[0].runtime.effects.unfinishedBuild = unfinishedBuild;
  // Simulate a pre-capability archive without losing its task history.
  delete archive.characters[0].permissions;
  delete archive.characters[0].skills;
  await writeFile(path, JSON.stringify(archive));
  const restored = setup(fakeSession(), decide);
  await restored.load();
  await vi.waitFor(() => expect(restored.list()[0].status).toBe('idle'));
  expect(restored.list()[0].permissions).toEqual({
    move: true,
    chat: true,
    place: true,
    remove: true,
  });
  const before = structuredClone(restored.list()[0]);
  const permissions = { move: false, chat: true, place: true, remove: false };
  await restored.update(created.id, {
    skills: ['building', 'exploration'],
    permissions,
  });
  const updated = restored.list()[0];
  expect(updated.task).toEqual({
    ...before.task,
    status: 'paused',
    reason: expect.stringContaining('进度已保留'),
  });
  expect(updated.usage).toEqual(before.usage);
  expect(decide).toHaveBeenCalledTimes(1);
  const saved = JSON.parse(await readFile(path, 'utf8')).characters[0];
  expect(saved.runtime.effects.unfinishedBuild).toEqual(unfinishedBuild);
  expect(saved.runtime.effects.previous).toEqual(
    archive.characters[0].runtime.effects.previous,
  );
  await restored.close();
  const finalSession = fakeSession();
  const finalManager = setup(finalSession, decide);
  await finalManager.load();
  expect(finalManager.list()[0]).toMatchObject({
    permissions,
    skills: ['building', 'exploration'],
    task: { status: 'paused', calls: before.task!.calls },
  });
  await controlRun(finalManager, created.id, 'resume');
  await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(finalManager.list()[0].status).toBe('idle'));
  expect(finalManager.list()[0].task!.calls).toBe(before.task!.calls + 1);
  expect(finalSession.move).not.toHaveBeenCalled();
  expect(
    finalSession.request.mock.calls.filter(([type]) => type === 'edit'),
  ).toEqual([]);
  const context = decide.mock.calls[1][1] as {
    previous?: unknown;
    unfinishedBuild?: unknown;
  };
  expect(context.unfinishedBuild).toBeDefined();
});

it.each(['completed', 'cancelled'] as const)(
  'keeps %s tasks ended when capabilities change',
  async (status) => {
    const m = setup(fakeSession(), async () => ({
      actions: [{ type: 'wait' }],
      task: {
        intent: 'continue',
        status: status === 'cancelled' ? 'needs_input' : 'completed',
        summary: 'test',
      },
    }));
    const job = await createWithTask(m, settings);
    await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
    if (status === 'cancelled') await controlRun(m, job.id, 'cancel');
    expect(m.list()[0].task?.status).toBe(status);
    const task = structuredClone(m.list()[0].task);
    await m.update(job.id, {
      skills: ['guide'],
      permissions: { move: false, chat: false, place: false, remove: false },
    });
    expect(m.list()[0].task).toEqual(task);
  },
);

it('suppresses voice bindings and direct pause receipts while retaining the saved voice preference', async () => {
  const voices = new VoiceServiceStore(join(dir, 'voices.json'));
  await voices.load();
  const bind = vi.spyOn(voices, 'bind');
  const s = fakeSession();
  const decide = vi.fn<Planner['decide']>(async () => ({
    actions: [{ type: 'wait' }],
    task: { intent: 'continue', status: 'needs_input', summary: '等待确认' },
  }));
  const m = setup(s, decide, voices);
  const job = await createWithTask(m, {
    ...settings,
    maxTurns: 30,
    voiceReplies: true,
  });
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  await m.update(job.id, {
    skills: ['guide'],
    permissions: { move: true, chat: false, place: false, remove: false },
  });
  expect(m.list()[0].voiceReplies).toBe(true);
  expect(s.request).toHaveBeenCalledWith('agent.voice', { enabled: false });
  expect(bind).toHaveBeenLastCalledWith('player-1', '');
  await expect(m.setVoice(job.id, { enabled: true })).rejects.toThrow(
    '聊天权限',
  );
  s.request.mockClear();
  s.onEvent!({
    seq: 5,
    at: Date.now(),
    type: 'chat',
    actor: 'human',
    actorKind: 'human',
    data: {
      scope: 'private',
      recipients: ['player-1'],
      kind: 'text',
      text: '取消任务',
      name: 'Person',
    },
  });
  await vi.waitFor(() => expect(m.list()[0].task!.status).toBe('cancelled'));
  expect(s.request.mock.calls.filter(([type]) => type === 'chat')).toEqual([]);
  await m.update(job.id, {
    permissions: { move: true, chat: true, place: false, remove: false },
  });
  expect(s.request).toHaveBeenCalledWith('agent.voice', { enabled: true });
  expect(bind).toHaveBeenLastCalledWith('player-1', 'local-default');
});

it('applies task budgets on assignment and renewal, rejecting invalid budgets before pausing', async () => {
  const s = fakeSession();
  const decide = vi.fn(async () => ({
    actions: [{ type: 'wait' as const }],
    task: {
      intent: 'continue' as const,
      status: 'running' as const,
      summary: '保留进展',
    },
  }));
  const m = setup(s, decide);
  const job = m.create({ ...settings, goal: '' });
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  await startTask(m, job.id, {
    goal: '测试任务',
    maxTurns: 1,
    tokenBudget: 10000,
    taskTimeoutMs: 120000,
  });
  await vi.waitFor(() => expect(m.list()[0].task?.status).toBe('budget'));
  const before = m.list()[0];
  await expect(
    startTask(m, job.id, { goal: '不能替换', maxTurns: 0 }),
  ).rejects.toThrow();
  expect(m.list()[0].task).toEqual(before.task);
  await controlRun(m, job.id, 'resume', {
    maxTurns: 2,
    tokenBudget: 20000,
    taskTimeoutMs: 180000,
  });
  expect(m.list()[0].taskExecution?.limits).toMatchObject({
    maxTurns: 2,
    tokenBudget: 20000,
    taskTimeoutMs: 180000,
  });
  expect(m.list()[0].task?.goal).toBe('测试任务');
  expect(m.list()[0].usage?.calls).toBe(before.usage?.calls);
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  await controlRun(m, job.id, 'pause');
  await m.close();
  manager = undefined;
  const restored = setup(fakeSession());
  await restored.load();
  expect(restored.list()[0].taskExecution?.limits).toMatchObject({
    maxTurns: 2,
    tokenBudget: 20000,
    taskTimeoutMs: 180000,
  });
});

it('uses newly saved provider configuration on the next decision without resetting progress', async () => {
  const s = fakeSession();
  const configs: unknown[] = [];
  manager = new AICharacterManager(store, 'ws://fixture', {
    session: () => s as unknown as Session,
    runner: fixtureRunnerFactory((config) => {
      configs.push(config);
      return {
        decide: async () => ({
          actions: [{ type: 'wait' }],
          task: { intent: 'continue', status: 'completed', summary: 'done' },
        }),
      };
    }),
  });
  const job = manager.create({ ...settings, goal: '', maxTokens: 777 });
  await vi.waitFor(() => expect(manager!.list()[0].status).toBe('idle'));
  await store.save(
    { ...store.get('deepseek'), apiKey: 'updated-key' },
    'deepseek',
  );
  expect(configs).toHaveLength(0);
  await manager.tasks.createTaskPlan(job.id, {
    name: 'Wait',
    goal: 'Wait',
    timing: { kind: 'immediate' },
    timeZone: 'UTC',
  });
  await vi.waitFor(() =>
    expect(manager!.list()[0].task?.status).toBe('completed'),
  );
  expect((configs[0] as { apiKey: string }).apiKey).toBe('updated-key');
});

it('migrates a legacy archive and reloads 500 timestamped activity records without truncating to the old limit', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const m = setup(fakeSession());
  const created = m.create({ ...settings, goal: '' });
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  const logged = m.list()[0];
  expect(logged.logEntries.length).toBeGreaterThan(0);
  expect(
    logged.logEntries.every(
      (entry) =>
        typeof entry.text === 'string' && typeof entry.time === 'number',
    ),
  ).toBe(true);
  await m.stop(created.id);
  await m.close();
  const path = `${store.path}.agents.json`;
  const archive = JSON.parse(await readFile(path, 'utf8'));
  archive.characters[0].status = 'stopped';
  // Simulate the pre-logEntries archive: two parallel legacy arrays.
  archive.characters[0].logs = Array.from(
    { length: 510 },
    (_, i) => `entry-${i}`,
  );
  archive.characters[0].logTimes = Array.from(
    { length: 510 },
    (_, i) => 1000 + i,
  );
  delete archive.characters[0].logEntries;
  await writeFile(path, JSON.stringify(archive));
  const expected = archive.characters[0].logs
    .slice(-500)
    .map((text: string, i: number) => ({
      time: archive.characters[0].logTimes.slice(-500)[i],
      text,
    }));
  const restored = setup(fakeSession());
  await restored.load();
  expect(restored.list()[0].logEntries).toEqual(expected);
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  expect(persisted.characters[0].logEntries).toEqual(expected);
});

it('deletes a resident character and its tasks durably, preserving shared services', async () => {
  const session = fakeSession();
  const m = setup(session);
  const job = await createWithTask(m, settings);
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  expect(m.tasks.taskPlans(job.id).length).toBeGreaterThan(0);
  await m.remove(job.id);
  expect(session.close).toHaveBeenCalled();
  expect(m.list()).toEqual([]);
  expect(() => m.tasks.taskPlans(job.id)).toThrow('不存在');
  expect(store.get('deepseek')).toBeDefined();
  await expect(m.remove(job.id)).rejects.toMatchObject({ status: 404 });
  await m.close();
  const restored = setup(fakeSession());
  await restored.load();
  expect(restored.list()).toEqual([]);
});

it('aborts an active decision and blocks concurrent join/delete before removal completes', async () => {
  let release!: () => void;
  let signal: AbortSignal | undefined;
  const decide = vi.fn<Planner['decide']>(async (_obs, _history, abort) => {
    signal = abort;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      actions: [{ type: 'chat', text: 'must not send' }],
      task: { intent: 'continue', status: 'completed', summary: 'done' },
    };
  });
  const session = fakeSession();
  const m = setup(session, decide);
  const job = await createWithTask(m, settings);
  await vi.waitFor(() => expect(decide).toHaveBeenCalled());
  const removing = m.remove(job.id);
  expect(signal?.aborted).toBe(true);
  expect(() => m.join(job.id)).toThrow();
  await expect(m.remove(job.id)).rejects.toMatchObject({ status: 409 });
  release();
  await removing;
  expect(m.list()).toEqual([]);
  expect(session.request.mock.calls.some(([type]) => type === 'chat')).toBe(
    false,
  );
});

it('keeps a stopped character recoverable when deletion cannot be persisted', async () => {
  const { mkdir, rename } = await import('node:fs/promises');
  const m = setup(fakeSession());
  const job = await createWithTask(m, settings);
  await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
  const blocked = `${store.path}.agents.json`;
  await rename(blocked, blocked + '.fixture-backup');
  await mkdir(blocked);
  try {
    await expect(m.remove(job.id)).rejects.toThrow();
    expect(m.list()[0]).toMatchObject({ id: job.id, status: 'stopped' });
  } finally {
    await rm(blocked, { recursive: true, force: true });
    await rename(blocked + '.fixture-backup', blocked);
  }
});

it.each(['completed', 'cancelled'] as const)(
  'preserves %s task history, usage and restart state after repeated pause/cancel',
  async (status) => {
    const m = setup(fakeSession(), async () => ({
      actions: [{ type: 'wait' }],
      task: {
        intent: 'continue',
        status: status === 'cancelled' ? 'needs_input' : 'completed',
        summary: '保留结果',
      },
    }));
    const job = await createWithTask(m, settings);
    await vi.waitFor(() => expect(m.list()[0].status).toBe('idle'));
    if (status === 'cancelled') await controlRun(m, job.id, 'cancel');
    const before = m.list()[0];
    const plan = m.tasks.taskPlans(job.id)[0];
    const history = m.tasks.taskRuns(job.id, plan.id);
    for (const op of ['cancel', 'pause', 'cancel'] as const) {
      await expect(controlRun(m, job.id, op)).rejects.toThrow('执行已结束');
      expect(m.list()[0].task).toEqual(before.task);
      expect(m.list()[0].usage).toEqual(before.usage);
      expect(m.tasks.taskRuns(job.id, plan.id)).toEqual(history);
    }
    await m.close();
    const restored = setup(fakeSession());
    await restored.load();
    expect(restored.list()[0].task).toEqual(before.task);
    const reloaded = restored.tasks.taskRuns(job.id, plan.id);
    expect(reloaded.items.map(({ logs: _, ...run }) => run)).toEqual(
      history.items.map(({ logs: _, ...run }) => run),
    );
    expect(
      reloaded.items[0].logs.slice(0, history.items[0].logs.length),
    ).toEqual(history.items[0].logs);
  },
);

it.each(['cancel', 'pause'] as const)(
  'preserves completion that settles while %s waits for the runner',
  async (operation) => {
    const s = fakeSession();
    let entered = false;
    manager = new AICharacterManager(store, 'ws://fixture', {
      session: () => s as unknown as Session,
      runner: () => ({
        async run({ memory, signal, checkpoint }) {
          entered = true;
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          // Simulate an already-confirmed action finishing its durable checkpoint.
          memory.task.current!.status = 'completed';
          memory.task.current!.reason = '动作已确认完成';
          await checkpoint?.();
        },
      }),
    });
    const job = await createWithTask(manager, settings);
    await vi.waitFor(() => expect(entered).toBe(true));
    await controlRun(manager, job.id, operation);
    expect(manager.list()[0].task).toMatchObject({
      status: 'completed',
      reason: '动作已确认完成',
    });
    expect(manager.tasks.taskPlans(job.id)[0].latestRun?.status).toBe(
      'completed',
    );
  },
);

it.each([
  { startTask: true },
  { startTask: false },
  { taskTimeZone: 'UTC' },
  { goal: 'A new task' },
  { goal: 'Wait' },
])(
  'rejects task fields %j on create/update without changing task state or history',
  async (input) => {
    const decide = vi.fn<Planner['decide']>(async () => ({
      actions: [{ type: 'wait' }],
      task: {
        intent: 'continue',
        status: 'needs_input',
        summary: 'Keep progress',
      },
    }));
    const m = setup(fakeSession(), decide);
    const job = await createWithTask(m, { ...settings, maxTurns: 30 });
    await m.settled(job.id);
    const before = structuredClone(m.list());
    const plans = structuredClone(m.plans.plans),
      runs = structuredClone(m.plans.runs);
    const calls = decide.mock.calls.length;
    expect(() =>
      m.create({ providerId: 'deepseek', name: 'Rejected', ...input }),
    ).toThrow('Tasks');
    await expect(
      m.update(job.id, { name: 'Rejected rename', ...input }),
    ).rejects.toThrow('Tasks');
    expect(m.list()).toEqual(before);
    expect(m.plans.plans).toEqual(plans);
    expect(m.plans.runs).toEqual(runs);
    expect(decide).toHaveBeenCalledTimes(calls);
    await m.update(job.id, { goal: '', roleDescription: 'Updated profile' });
    expect(m.list()[0].task).toEqual(before[0].task);
    expect(m.list()[0].usage).toEqual(before[0].usage);
    expect(m.plans.plans).toEqual(plans);
    expect(m.plans.runs.map((run) => run.id)).toEqual(
      runs.map((run) => run.id),
    );
  },
);

it('creates an offline profile without joining or allocating a plan, then joins and restores in standby', async () => {
  const session = fakeSession(),
    decide = vi.fn();
  const m = setup(session, decide);
  const job = m.create({
    providerId: 'deepseek',
    name: 'Offline',
    joinWorld: false,
  });
  await m.flush();
  expect(job.status).toBe('stopped');
  expect(session.join).not.toHaveBeenCalled();
  expect(m.plans.plans).toHaveLength(0);
  expect(m.plans.runs).toHaveLength(0);
  expect(m.taskIdentity(job.id)).toBeUndefined();
  await m.close();
  const restored = setup(session, decide);
  await restored.load();
  expect(restored.list()[0].status).toBe('stopped');
  expect(session.join).not.toHaveBeenCalled();
  restored.join(job.id);
  await restored.settled(job.id);
  expect(restored.list()[0].status).toBe('idle');
  expect(restored.list()[0].task).toBeUndefined();
  expect(restored.plans.plans).toHaveLength(0);
  expect(restored.plans.runs).toHaveLength(0);
  expect(decide).not.toHaveBeenCalled();
});

it('restores the live task adapter and full profile after a failed task reservation, without launching a runner', async () => {
  const { rename } = await import('node:fs/promises');
  const decide = vi.fn();
  const m = setup(fakeSession(), decide);
  const job = m.create({
    providerId: 'deepseek',
    name: 'Standby',
    roleDescription: 'Keep identity',
  });
  await m.settled(job.id);
  const before = structuredClone(m.list()[0]);
  await rename(dir, `${dir}-away`);
  try {
    await expect(
      startTask(m, job.id, { goal: 'Must not launch' }),
    ).rejects.toThrow();
    expect(m.list()[0]).toEqual(before);
    expect(m.currentRunId(job.id)).toBeUndefined();
    expect(m.plans.plans).toHaveLength(0);
    expect(m.plans.runs).toHaveLength(0);
    expect(decide).not.toHaveBeenCalled();
  } finally {
    await rename(`${dir}-away`, dir);
  }
});

it('forwards the task lease, stable command ID and player event through the real host control path', async () => {
  const session = fakeSession();
  const m = setup(session, async () => ({
    actions: [{ type: 'wait' }],
    task: {
      intent: 'continue',
      status: 'needs_input',
      summary: 'Waiting for player',
    },
  }));
  const job = await createWithTask(m, { ...settings, maxTurns: 30 });
  await m.settled(job.id);
  const lease = structuredClone(m.taskIdentity(job.id));
  const message: WorldEvent = {
    seq: 123,
    at: Date.now(),
    type: 'chat',
    actor: 'person',
    actorKind: 'human',
    data: {
      text: '暂停',
      name: 'Person',
      kind: 'text',
      scope: 'private',
      recipients: ['player-1'],
    },
  };
  const control = vi.spyOn(m.tasks, 'controlMessage');
  session.onEvent!(message);
  expect(control).toHaveBeenCalledWith(
    job.id,
    'pause',
    lease,
    expect.stringMatching(/^world-.*-123$/),
    message,
  );
  await vi.waitFor(() => expect(m.list()[0].task?.status).toBe('paused'));
  session.onEvent!(message);
  expect(control).toHaveBeenCalledTimes(1);
});
