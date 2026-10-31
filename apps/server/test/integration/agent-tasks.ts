import { delay, Session, until } from '@voxel/agent-runtime';

import type { ChatData } from '@voxel/shared';
import assert from 'node:assert/strict';
import { controlRun, startTask } from '../../../../tests/support/managed-tasks';
import { toolResponse } from '../../../../tests/support/pi-response';
import { AICharacterManager } from '../../src/modules/ai-characters';
import {
  bootstrapProviders,
  MemoryProviderRepository,
} from '../helpers/memory-storage';
import { createTestServer } from '../helpers/test-server';

const origin = 'http://127.0.0.1:5188';
const preview = process.env.TASK_PREVIEW === '1';
let server: Awaited<ReturnType<typeof createTestServer>> | undefined;
let manager: AICharacterManager | undefined;
let human: Session | undefined;
let other: Session | undefined;
let calls = 0;

try {
  const store = new MemoryProviderRepository();
  await bootstrapProviders(store);
  await store.save(
    {
      name: 'DeepSeek',
      type: 'deepseek',
      apiKey: 'fixture-only',
      defaultModel: 'deepseek-flash',
    },
    'deepseek',
  );
  // Only the provider's SSE response is scripted; all task and world behavior is production code.
  const request: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init!.body as string);
    const userIndex = body.messages
      .map((message: { role: string }) => message.role)
      .lastIndexOf('user');
    const content = body.messages[userIndex].content;
    const input = JSON.parse(
      typeof content === 'string' ? content : content[0].text,
    );
    const message = input.currentRequest?.text ?? '';
    const goal = input.previous.task?.goal ?? '';
    const toolResults = body.messages
      .slice(userIndex + 1)
      .filter((item: { role: string }) => item.role === 'tool');
    const complete = {
      name: 'complete_task',
      arguments: { summary: '已检查结果' },
    };
    if (message.includes('建造')) {
      return toolResponse(
        toolResults.length
          ? [{ name: 'chat', arguments: { text: '木方块已放好。' } }, complete]
          : [
              {
                name: 'start_task',
                arguments: {
                  goal: '放置木方块并确认',
                  reply: '收到，开始建造。',
                },
              },
              {
                name: 'edit',
                arguments: { x: 2, y: 3, z: 1, material: 'wood' },
              },
            ],
        120,
      );
    }
    if (message === '到我这里来') {
      return toolResponse(
        toolResults.length
          ? [complete]
          : [
              {
                name: 'start_task',
                arguments: { goal: '靠近发送者', reply: '收到，正在靠近。' },
              },
              {
                name: 'goto',
                arguments: {
                  x: input.observation.self.x + 1,
                  y: input.observation.self.y,
                  z: input.observation.self.z,
                },
              },
            ],
        120,
      );
    }
    if (message)
      return toolResponse(
        [{ name: 'reply', arguments: { text: '收到，这是一条单次回复。' } }],
        120,
      );
    if (goal.includes('慢请求')) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30000);
        init!.signal!.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(Error('aborted'));
          },
          { once: true },
        );
      });
      return toolResponse(
        [{ name: 'edit', arguments: { x: 2, y: 4, z: 1, material: 'wood' } }],
        120,
      );
    }
    if (goal.includes('循环'))
      return toolResponse([{ name: 'observe', arguments: {} }], 120);
    if (goal.includes('等待'))
      return toolResponse(
        [
          {
            name: 'wait_for',
            arguments: { condition: 'world', reason: '等待附近方块变化。' },
          },
        ],
        120,
      );
    if (goal.startsWith('批次')) {
      if (toolResults.length) {
        const failed = toolResults.some((item: { content: string }) =>
          /conflict|occupied|当前批次已停止|movement_stalled/.test(
            item.content,
          ),
        );
        return toolResponse(
          failed
            ? [
                {
                  name: 'request_input',
                  arguments: { question: '动作受阻，请确认。' },
                },
              ]
            : [complete],
          120,
        );
      }
      if (goal === '批次暂停')
        return toolResponse(
          [
            { name: 'goto', arguments: { x: 10, y: 2.5, z: 0 } },
            { name: 'edit', arguments: { x: 3, y: 3, z: 2, material: 'wood' } },
          ],
          120,
        );
      const z = goal === '批次失败' ? 1 : 0;
      return toolResponse(
        [
          { name: 'edit', arguments: { x: 3, y: 3, z, material: 'wood' } },
          {
            name: 'edit',
            arguments: {
              x: 3,
              y: goal === '批次失败' ? 3 : 4,
              z,
              material: goal === '批次失败' ? 'stone' : 'wood',
            },
          },
          { name: 'chat', arguments: { text: '批次施工进展' } },
        ],
        120,
      );
    }
    return toolResponse([complete], 120);
  };
  const dependencies: NonNullable<
    ConstructorParameters<typeof AICharacterManager>[3]
  > = {
    session: (url) => new Session(url),
    model: (_config, provider) => ({ endpoint: provider, request: request }),
  };
  server = await createTestServer({
    providers: store,
    origin,
    port: preview ? 2578 : 0,
    agentDependencies: dependencies,
  });
  manager = server.characters;
  const room = server.world;
  const response = await fetch(`${server.httpUrl}/ai-characters`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer fixture-gateway-token-for-tests',
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      providerId: 'deepseek',
      name: '任务测试员',
      maxTurns: 30,
      intervalMs: 1000,
      permissions: { move: true, chat: true, place: true, remove: true },
    }),
  });
  assert.equal(response.status, 201);
  const { id } = (await response.json()) as { id: string };
  const current = () => manager!.list().find((role) => role.id === id)!;
  const task = (goal: string, limits = {}) =>
    startTask(manager!, id, { goal, ...limits });
  const control = (command: 'pause' | 'resume' | 'cancel', limits = {}) =>
    controlRun(manager!, id, command, limits);
  await until(() => current().status === 'idle');
  assert.equal(calls, 0);
  assert.equal(current().task, undefined);
  await task('检查附近环境一次');
  await until(() => current().task?.status === 'completed');
  const identity = current().sessionId!;
  assert.equal(calls, 1);
  await delay(1100);
  assert.equal(calls, 1, 'Completed tasks do not poll inference');
  if (preview) {
    await task('等待附近方块变化');
    await until(() => current().task?.status === 'waiting');
    console.log(
      'Task preview ready at backend 2578; provider responses are local SSE fixtures.',
    );
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } else {
    human = await new Session(server.url).join('任务发起者', 'human');
    other = await new Session(server.url).join('旁观者', 'human');
    const say = (text: string) =>
      human!.request('chat', {
        scope: 'private',
        recipients: [identity],
        text,
      });
    await say('你好');
    await until(() => calls === 2 && current().status === 'idle');
    assert.equal(current().task?.status, 'completed');
    await delay(400);
    await say('请建造一个木方块');
    await until(
      () =>
        current().task?.goal.includes('木方块') === true &&
        current().task?.status === 'completed',
    );
    assert.equal(
      calls,
      5,
      'Start and edit are followed by a private report and task completion',
    );
    assert.equal(room.blocks.get('2,3,1')?.material, 'wood');
    await until(() =>
      human!.events.some(
        (event) => (event.data as Partial<ChatData>).text === '木方块已放好。',
      ),
    );
    assert(
      !other.events.some(
        (event) => (event.data as Partial<ChatData>).text === '木方块已放好。',
      ),
      'Private reports stay private',
    );
    const oldX = room.state.players.get(identity)!.x;
    await delay(400);
    await say('到我这里来');
    await until(
      () =>
        current().task?.goal === '靠近发送者' &&
        current().task?.status === 'completed',
    );
    assert(room.state.players.get(identity)!.x > oldX);
    assert.equal(current().sessionId, identity);
    await task('等待附近方块变化');
    await until(() => current().task?.status === 'waiting');
    const waitingCalls = calls;
    await delay(2200);
    assert.equal(calls, waitingCalls, 'Unchanged waits spend no requests');
    await control('pause');
    assert.equal(current().task?.status, 'paused');
    await control('resume');
    await until(
      () => calls === waitingCalls + 1 && current().task?.status === 'waiting',
    );
    await control('cancel');
    const beforeLoop = calls;
    await task('循环检查', { maxTurns: 2 });
    await until(() => current().task?.status === 'budget');
    assert.equal(calls, beforeLoop + 2);
    const runId = current().taskExecution!.runId;
    const tokens = current().task!.tokens;
    await control('resume', { maxTurns: 4 });
    await until(() => current().task?.status === 'budget');
    assert.equal(current().taskExecution!.runId, runId);
    assert.equal(current().task!.calls, 4);
    assert(current().task!.tokens > tokens);
    await control('cancel');
    const beforeSlow = calls;
    await task('慢请求测试');
    await until(() => calls === beforeSlow + 1);
    await say('暂停');
    await until(() => current().task?.status === 'paused');
    assert(
      !room.blocks.has('2,4,1'),
      'Cancelled inference cannot execute a late write',
    );
    const beforeRestore = calls;
    await manager.close();
    manager = new AICharacterManager(
      store,
      server.url,
      store.archive,
      dependencies,
    );
    await manager.load();
    assert.equal(calls, beforeRestore);
    assert.equal(current().task?.status, 'paused');
    await control('cancel');
    await task('批次成功', { maxTurns: 30 });
    await until(() => current().task?.status === 'completed');
    assert.equal(room.blocks.get('3,3,0')?.material, 'wood');
    assert.equal(room.blocks.get('3,4,0')?.material, 'wood');
    const actions =
      manager.plans.runs.find((run) => run.id === manager!.currentRunId(id))!
        .actions ?? [];
    assert.equal(
      actions.filter(
        (action) => action.kind === 'edit' && action.status === 'succeeded',
      ).length,
      2,
    );
    await task('批次失败');
    await until(() => current().task?.status === 'needs_input');
    assert.equal(room.blocks.get('3,3,1')?.material, 'wood');
    const failed =
      manager.plans.runs.find((run) => run.id === manager!.currentRunId(id))!
        .actions ?? [];
    assert(failed.some((action) => action.status === 'failed'));
    assert(
      !failed.some(
        (action) => action.kind === 'chat' && action.status === 'succeeded',
      ),
      'A failed tool skips the remaining tools',
    );
    await control('cancel');
    const beforePause = calls;
    await task('批次暂停');
    await until(
      () =>
        calls === beforePause + 1 &&
        current().logEntries.some((entry) => entry.text.includes('goto')),
    );
    await delay(100);
    await control('pause');
    assert.equal(current().task?.status, 'paused');
    assert(!room.blocks.has('3,3,2'));
    const lastCalls = calls;
    await manager.close();
    manager = new AICharacterManager(
      store,
      server.url,
      store.archive,
      dependencies,
    );
    await manager.load();
    assert.equal(calls, lastCalls);
    assert(
      !room.blocks.has('3,3,2'),
      'Recovery never replays the trailing edit',
    );
    console.log(
      'PASS: real Pi SSE, private chat and reports, explicit tasks, world edits and movement, waits, budgets, pause/resume/cancel, restart recovery, tool failure and interrupted effects. No cloud calls.',
    );
  }
} finally {
  await human?.close();
  await other?.close();
  await manager?.close();
  await server?.close();
}
