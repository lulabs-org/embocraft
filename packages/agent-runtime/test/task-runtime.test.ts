import { newTask } from '@voxel/agent-runtime';
import { describe, expect, it } from 'vitest';
import { runtimeFixture } from './runtime-fixture';

const complete = {
  name: 'complete_task',
  arguments: { summary: '已确认完成' },
};
const wait = {
  name: 'wait_for',
  arguments: { condition: 'world', reason: '等待世界变化' },
};
const start = { name: 'start_task', arguments: { goal: '检查世界' } };
const reply = { name: 'reply', arguments: { text: '你好' } };

describe('task policy through the production Pi runner', () => {
  it('answers a greeting without restarting a completed task', async () => {
    const f = runtimeFixture([[reply]]);
    f.memory.task.current!.status = 'completed';
    const task = structuredClone(f.memory.task.current);
    f.message();
    await f.run();
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.memory.task.current).toEqual(task);
  });

  it('starts an explicitly requested task, completes it, and stops polling', async () => {
    const f = runtimeFixture([[start, complete]]);
    delete f.memory.task.current;
    f.message('private', 'human', '请检查世界');
    await f.run();
    expect(f.memory.task.current).toMatchObject({
      goal: '检查世界',
      status: 'completed',
      owner: 'human',
      privateTo: 'human',
      calls: 1,
    });
    await f.run();
    expect(f.request).toHaveBeenCalledOnce();
  });

  it('does not spend requests while waiting on an unchanged world', async () => {
    const f = runtimeFixture([[wait], [complete]]);
    await f.run();
    await f.run();
    expect(f.request).toHaveBeenCalledOnce();
    f.world.blocks.push({ x: 2, y: 3, z: 0, material: 'wood' });
    f.world.revision++;
    await f.run();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.memory.task.current?.status).toBe('completed');
  });

  it.each(['request_input', 'report_blocked'] as const)(
    'parks %s and only resumes on an authorized command',
    async (name) => {
      const f = runtimeFixture([
        [
          {
            name,
            arguments:
              name === 'request_input'
                ? { question: '确认？' }
                : { reason: '受阻' },
          },
        ],
        [{ name: 'revise_task', arguments: { goal: '新目标' } }, complete],
      ]);
      await f.run();
      await f.run();
      expect(f.request).toHaveBeenCalledOnce();
      f.message('private', 'human', '改为新目标');
      await f.run();
      expect(f.memory.task.current).toMatchObject({
        goal: '新目标',
        status: 'completed',
      });
    },
  );

  it.each(['tokens', 'time'] as const)(
    'stops before inference when the %s budget is exhausted',
    async (kind) => {
      const f = runtimeFixture([[complete]]);
      if (kind === 'tokens')
        f.memory.task.current!.tokens = f.config.tokenBudget!;
      else f.memory.task.current!.elapsedMs = f.config.taskTimeoutMs;
      await f.run();
      expect(f.request).not.toHaveBeenCalled();
      expect(f.memory.task.current?.status).toBe('budget');
    },
  );

  it.each(['pause_task', 'cancel_task'] as const)(
    'honors %s without replacing the character or starting new work',
    async (name) => {
      const f = runtimeFixture([[{ name, arguments: {} }, reply]]);
      const startedAt = f.memory.task.current!.startedAt;
      f.message('private', 'human', name === 'pause_task' ? '暂停' : '取消');
      await f.run();
      expect(f.memory.task.current).toMatchObject({
        startedAt,
        status: name === 'pause_task' ? 'paused' : 'cancelled',
      });
      await f.run();
      expect(f.request).toHaveBeenCalledOnce();
      expect(f.session.move).not.toHaveBeenCalled();
    },
  );

  it('cannot create an activity from an automatic poll', async () => {
    const f = runtimeFixture([[start], [complete]]);
    const original = structuredClone(f.memory.task.current);
    await f.run();
    expect(f.memory.task.current?.goal).toBe(original?.goal);
    expect(f.memory.task.current?.startedAt).toBe(original?.startedAt);
    expect(String(f.request.mock.calls[1][1]?.body)).toContain(
      '任务控制需要明确玩家指令',
    );
  });

  it('does not leak private activity details into a public reply', async () => {
    const f = runtimeFixture([[reply]]);
    f.memory.task.current = {
      ...newTask('private-marker'),
      status: 'paused',
      owner: 'owner',
      privateTo: 'owner',
    };
    const before = structuredClone(f.memory.task.current);
    f.message('public', 'visitor', '你好');
    await f.run();
    expect(String(f.request.mock.calls[0][1]?.body)).not.toContain(
      'private-marker',
    );
    expect(f.memory.task.current).toEqual(before);
  });

  it('keeps accounting beyond saved caps when limits are explicitly disabled', async () => {
    const f = runtimeFixture([[wait]]);
    // Hosts resolve disabled limits to infinite runtime budgets.
    f.config.maxTurns = Infinity;
    f.config.tokenBudget = Infinity;
    f.config.taskTimeoutMs = Infinity;
    f.memory.task.current!.calls = 50;
    f.memory.task.current!.tokens = 5000;
    await f.run();
    expect(f.memory.task.current).toMatchObject({
      status: 'waiting',
      calls: 51,
      tokens: 5100,
    });
  });
});
