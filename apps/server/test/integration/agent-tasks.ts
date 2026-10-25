import { LIMIT, type ChatData } from '@voxel/shared';
import {
  startTask,
  controlRun as controlManagedRun,
} from '../../../../tests/support/managed-tasks';
import { createTestServer } from '../helpers/test-server';
import { DecisionFixture as ModelPlanner } from './../../../../tests/support/decision-fixture';
import { fixtureRunnerFactory } from './../../../../tests/support/decision-fixture';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AICharacterManager } from '../../src/modules/ai-characters';
import { ProviderStore } from '../../src/modules/providers/provider-store';
import { Session, until, delay } from '@voxel/agent-runtime';

import type { AICharacterView, TaskRun } from '@voxel/shared';

process.env.DATABASE_URL = '';
process.env.VOICE_PROVIDER = 'mock';
process.env.WEB_ORIGIN = 'http://127.0.0.1:5188';
const preview = process.env.TASK_PREVIEW === '1';
const dir = await mkdtemp(join(tmpdir(), 'voxel-tasks-'));
let server: Awaited<ReturnType<typeof createTestServer>> | undefined;
let manager: AICharacterManager | undefined,
  human: Session | undefined,
  other: Session | undefined;
let calls = 0;
type FixturePrompt = {
  previous: {
    previous: {
      results: { status: string; result: { ok: boolean } }[];
      stopReason?: string;
    };
  };
};
const prompts: FixturePrompt[] = [];
try {
  const store = new ProviderStore(join(dir, 'providers.json'));
  await store.load({ DEEPSEEK_API_KEY: 'fixture-only' });
  const request: typeof fetch = async (_url, init) => {
    calls++;
    const prompt = JSON.parse(
      JSON.parse(init!.body as string).messages[1].content,
    );
    prompts.push(prompt);
    const message = prompt.observation.attention?.data.text ?? '';
    const task = prompt.previous.task;
    let action: unknown = {
      actions: [{ type: 'wait' }],
      task: {
        intent: 'continue',
        status: 'completed',
        summary: '检查完成，在线待命。',
      },
    };
    if (message.includes('建造'))
      action = {
        actions: [{ type: 'edit', x: 2, y: 3, z: 1, material: 'wood' }],
        task: {
          intent: 'task',
          status: 'running',
          goal: '在空地放置木方块并确认',
          summary: '开始放置木方块。',
        },
      };
    else if (message === '格式错误测试')
      action = {
        actions: [{ type: 'unsupported' }],
        task: { intent: 'reply', status: 'completed', summary: '无效动作' },
      };
    else if (message === '到我这里来')
      action = {
        actions: [{ type: 'move', x: 1, z: 0, jump: false, durationMs: 300 }],
        task: {
          intent: 'task',
          goal: '靠近发送者',
          status: 'waiting',
          waitFor: 'world',
          summary: '正在靠近玩家',
        },
      };
    else if (task?.goal === '靠近发送者' && !message)
      action = {
        actions: [{ type: 'chat', text: '已检查移动结果。' }],
        task: {
          intent: 'continue',
          status: 'completed',
          summary: '已检查位置',
        },
      };
    else if (message)
      action = {
        actions: [{ type: 'chat', text: '收到，这是一条单次回复。' }],
        task: {
          intent: 'reply',
          status: 'completed',
          summary: '已回复消息。',
          goal: null,
          waitFor: null,
        },
      };
    else if (task?.goal.includes('木方块'))
      action = {
        actions: [{ type: 'chat', text: '木方块已放好。' }],
        task: {
          intent: 'continue',
          status: 'completed',
          summary: '观察结果确认目标木方块已存在。',
        },
      };
    else if (task?.goal.includes('等待'))
      action = {
        actions: [{ type: 'wait' }],
        task: {
          intent: 'continue',
          status: 'waiting',
          waitFor: 'world',
          summary: '等待附近方块变化。',
        },
      };
    else if (task?.goal.includes('循环'))
      action = {
        actions: [{ type: 'wait' }],
        task: {
          intent: 'continue',
          status: 'running',
          summary: '继续下一次检查。',
        },
      };
    else if (task?.goal.includes('慢请求')) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30000);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(Error('aborted'));
          },
          { once: true },
        );
      });
      action = {
        actions: [{ type: 'edit', x: 2, y: 4, z: 1, material: 'wood' }],
        task: { intent: 'continue', status: 'running', summary: '迟到动作' },
      };
    }
    if (!message && task?.goal.startsWith('批次')) {
      const previous = prompt.previous.previous;
      const directive = {
        intent: 'continue',
        status: 'running',
        summary: '执行短动作序列',
      };
      if (previous?.results) {
        action = {
          actions: [{ type: 'wait' }],
          task: {
            ...directive,
            status: previous.ok ? 'completed' : 'needs_input',
            summary: '已检查整个批次结果',
          },
        };
      } else if (task.goal === '批次成功') {
        action = {
          actions: [
            { type: 'edit', x: 3, y: 3, z: 0, material: 'wood' },
            { type: 'edit', x: 3, y: 4, z: 0, material: 'wood' },
            { type: 'chat', text: '批次施工进展' },
          ],
          task: directive,
        };
      } else if (task.goal === '批次失败') {
        action = {
          actions: [
            { type: 'edit', x: 3, y: 3, z: 1, material: 'wood' },
            { type: 'edit', x: 3, y: 3, z: 1, material: 'stone' },
            { type: 'edit', x: 3, y: 4, z: 1, material: 'wood' },
          ],
          task: directive,
        };
      } else {
        action = {
          actions: [
            {
              type: 'move',
              x: 1,
              z: 0,
              jump: false,
              durationMs: task.goal === '批次暂停' ? 1500 : 300,
            },
            { type: 'edit', x: 3, y: 3, z: 2, material: 'wood' },
          ],
          task: directive,
        };
      }
    }
    return new Response(
      JSON.stringify({
        usage: { total_tokens: 120 },
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify(action),
            },
          },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  const dependencies: NonNullable<
    ConstructorParameters<typeof AICharacterManager>[2]
  > = {
    session: (address) => new Session(address),
    runner: fixtureRunnerFactory(
      (config, provider) => new ModelPlanner(config, request, provider),
    ),
  };
  server = await createTestServer({
    directory: dir,
    providers: store,
    origin: process.env.WEB_ORIGIN,
    port: preview ? 2578 : 0,
    agentDependencies: dependencies,
  });
  const room = server.world,
    url = server.httpUrl;
  const makeManager = () =>
    new AICharacterManager(store, server!.url, dependencies);
  manager = server.characters;
  const httpRequest = async <T>(
    path: string,
    method = 'POST',
    body: unknown = {},
    status = 200,
  ): Promise<T> => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: 'Bearer fixture-gateway-token-for-tests',
        Origin: process.env.WEB_ORIGIN!,
        'Content-Type': 'application/json',
      },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, status, await response.clone().text());
    return (await response.json()) as T;
  };
  const api = (path: string, method = 'POST', body: unknown = {}) =>
    httpRequest<AICharacterView>(
      `/ai-characters${path}`,
      method,
      body,
      path === '' ? 201 : 200,
    );
  const job = await api('', 'POST', {
    providerId: 'deepseek',
    name: '任务测试员',
    maxTurns: 30,
    intervalMs: 1000,
    allowEdits: true,
  });
  const current = () => manager!.list().find((j) => j.id === job.id)!;
  const controlRun = (operation: string, value: unknown = {}) =>
    httpRequest<TaskRun>(
      `/task-runs/${manager!.currentRunId(job.id)}/${operation}`,
      'POST',
      value,
    );
  const createTask = (goal: string) =>
    httpRequest(
      '/tasks',
      'POST',
      {
        characterId: job.id,
        name: goal,
        goal,
        timing: { kind: 'immediate' },
        timeZone: 'UTC',
        limits: {
          maxTurns: current().maxTurns,
          tokenBudget: current().tokenBudget,
          taskTimeoutMs: current().taskTimeoutMs,
        },
      },
      201,
    );
  await until(() => current().status === 'idle');
  assert.equal(current().task, undefined);
  assert.equal(calls, 0, 'creating a role only joins the world');
  await createTask('检查附近环境一次');
  await until(() => current().task?.status === 'completed');
  const identity = current().sessionId;
  assert.equal(calls, 1);
  await delay(1100);
  assert.equal(calls, 1, 'completed task must not poll the model');
  if (preview) {
    await startTask(manager, job.id, { goal: '等待附近方块变化' });
    await until(() => current().task?.status === 'waiting');
    console.log(
      'Task preview ready at backend 2578. All model responses are local fixtures.',
    );
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } else {
    human = await new Session(url.replace('http', 'ws')).join(
      '任务发起者',
      'human',
    );
    other = await new Session(url.replace('http', 'ws')).join(
      '旁观者',
      'human',
    );
    const say = (text: string) =>
      human!.request('chat', {
        scope: 'private',
        recipients: [identity],
        text,
      });
    await say('你好');
    await until(() => calls === 2 && current().status === 'idle');
    await delay(1100);
    assert.equal(calls, 2, 'private greeting must not trigger 30 calls');
    await say('请建造一个木方块');
    await until(
      () =>
        current().task?.goal.includes('木方块') === true &&
        current().task?.status === 'completed',
    );
    assert.equal(calls, 4, 'one instruction and one follow-up verification');
    assert.equal(room.blocks.get('2,3,1')?.material, 'wood');
    assert.equal(current().sessionId, identity);
    await until(() =>
      human!.events.some(
        (e) => (e.data as Partial<ChatData>).text === '木方块已放好。',
      ),
    );
    assert(
      !other.events.some(
        (e) => (e.data as Partial<ChatData>).text === '木方块已放好。',
      ),
      'private task report stays private',
    );
    assert.equal(prompts.at(-1)!.previous.previous.results[0].result.ok, true);
    const beforeFailure = calls;
    await human.request('chat', {
      scope: 'public',
      recipients: [identity],
      text: '格式错误测试',
    });
    await until(
      () => calls === beforeFailure + 1 && current().status === 'idle',
    );
    await until(() =>
      human!.events.some(
        (e) =>
          e.actor === identity &&
          (e.data as Partial<ChatData>).text?.includes('这条消息处理失败'),
      ),
    );
    assert(
      !other.events.some((e) =>
        (e.data as Partial<ChatData>).text?.includes('这条消息处理失败'),
      ),
      'failure receipts stay private',
    );
    const oldX = room.state.players.get(identity!)!.x;
    await human.request('chat', {
      scope: 'public',
      recipients: [identity],
      text: '到我这里来',
    });
    await until(
      () =>
        current().task?.goal === '靠近发送者' &&
        current().task?.status === 'completed',
    );
    assert.equal(
      calls,
      beforeFailure + 3,
      'failed mention followed by move and position verification',
    );
    assert(
      room.state.players.get(identity!)!.x > oldX,
      'movement really changes player position',
    );
    assert(
      human.events.some(
        (e) =>
          e.actor === identity &&
          (e.data as Partial<ChatData>).text?.includes('收到。正在靠近玩家'),
      ),
      'sender receives acknowledgement',
    );
    if (!['completed', 'cancelled'].includes(current().task?.status ?? ''))
      await controlRun('cancel');
    await createTask('等待附近方块变化');
    await until(() => current().task?.status === 'waiting');
    const waitingCalls = calls;
    await delay(2200);
    assert.equal(calls, waitingCalls, 'unchanged world polls use no model');
    await controlRun('pause');
    assert.equal(current().task?.status, 'paused');
    await controlRun('resume');
    await until(
      () => calls === waitingCalls + 1 && current().task?.status === 'waiting',
    );
    await controlRun('cancel');
    assert.equal(current().task?.status, 'cancelled');
    assert.equal(current().sessionId, identity);
    await api(`/${job.id}`, 'PUT', {
      intervalMode: 'random',
      intervalMinMs: 1000,
      intervalMaxMs: 1001,
      maxTurns: 2,
    });
    const beforeLoop = calls;
    await createTask('循环检查');
    await until(() => current().task?.status === 'budget');
    assert.equal(
      calls,
      beforeLoop + 2,
      'random polling performs one decision per interval and honors cap',
    );
    const tokensBeforeContinue = current().task!.tokens;
    const budgetExecution = current().taskExecution;
    assert.ok(
      budgetExecution,
      'chat-created tasks expose execution budget controls without a plan',
    );
    assert.equal(budgetExecution.limits.maxTurns, 2);
    const continued = await controlRun('resume', { maxTurns: 4 });
    assert.equal(current().taskExecution?.runId, budgetExecution.runId);
    assert.equal(current().taskExecution?.limits.maxTurns, 4);
    // A committed response can race the next model request; assert the command snapshot.
    assert.equal(
      continued.task!.calls,
      2,
      'continuation retains consumed calls',
    );
    assert.equal(
      continued.task!.tokens,
      tokensBeforeContinue,
      'continuation retains consumed tokens',
    );
    await until(() => calls === beforeLoop + 3 && current().status === 'idle');
    await controlRun('pause');
    const beforeSlow = calls;
    await controlRun('cancel');
    await createTask('慢请求测试');
    await until(() => calls === beforeSlow + 1);
    await say('暂停');
    await until(() => current().task?.status === 'paused');
    assert(
      !room.blocks.has('2,4,1'),
      'cancelled inference cannot execute a late edit',
    );
    assert.equal(current().sessionId, identity);
    const beforeRestore = calls,
      savedTask = current().task;
    await manager.close();
    manager = makeManager();
    await manager.load();
    assert.equal(calls, beforeRestore, 'restore never spends model calls');
    assert.equal(current().task?.goal, savedTask?.goal);
    assert.equal(current().task?.status, 'paused');
    assert(current().usage!.calls >= beforeRestore);
    await manager.update(job.id, {
      maxTurns: 30,
      intervalMode: 'fixed',
      intervalMs: 1000,
    });
    const beforeBatch = calls;
    await controlManagedRun(manager, job.id, 'cancel');
    await startTask(manager, job.id, { goal: '批次成功' });
    await until(() => current().task?.status === 'completed');
    assert.equal(
      calls,
      beforeBatch + 2,
      'three actions cost one call plus verification',
    );
    assert.equal(room.blocks.get('3,3,0')?.material, 'wood');
    assert.equal(room.blocks.get('3,4,0')?.material, 'wood');
    assert.deepEqual(
      prompts.at(-1)!.previous.previous.results.map((r) => r.status),
      ['succeeded', 'succeeded', 'succeeded'],
    );

    await startTask(manager, job.id, { goal: '批次失败' });
    await until(() => current().task?.status === 'needs_input');
    assert.equal(room.blocks.get('3,3,1')?.material, 'wood');
    assert.equal(room.blocks.has('3,4,1'), false);
    assert.deepEqual(
      prompts.at(-1)!.previous.previous.results.map((r) => r.status),
      ['succeeded', 'failed', 'pending'],
    );

    const player = room.state.players.get(current().sessionId!)!;
    const position = { x: player.x, y: player.y, z: player.z };
    player.x = LIMIT - 0.3;
    player.z = 0;
    player.y =
      Math.max(
        ...[...room.blocks.values()]
          .filter((b) => b.x === LIMIT && b.z === 0)
          .map((b) => b.y),
      ) + 0.5;
    await delay(300);
    await controlManagedRun(manager, job.id, 'cancel');
    await startTask(manager, job.id, { goal: '批次受阻' });
    await until(
      () =>
        current().task?.goal === '批次受阻' &&
        current().task?.status === 'needs_input',
    );
    assert.equal(
      prompts.at(-1)!.previous.previous.stopReason,
      'movement_stalled',
    );
    assert.equal(
      prompts.at(-1)!.previous.previous.results[1].status,
      'pending',
    );
    Object.assign(player, position);

    const beforePause = calls;
    await controlManagedRun(manager, job.id, 'cancel');
    await startTask(manager, job.id, { goal: '批次暂停' });
    await until(
      () =>
        calls === beforePause + 1 &&
        current().logEntries.some((entry) =>
          entry.text.includes('第 1/2 个动作：move'),
        ),
    );
    await delay(100);
    await controlManagedRun(manager, job.id, 'pause');
    assert.equal(current().task?.status, 'paused');
    assert.equal(
      room.blocks.has('3,3,2'),
      false,
      'pause prevents trailing edit',
    );
    const saved = JSON.parse(
      await readFile(join(dir, 'providers.json.agents.json'), 'utf8'),
    ).characters.find((j: { id: string }) => j.id === job.id);
    assert.equal(
      saved.runtime.effects.previous.results[0].status,
      'interrupted',
    );
    assert.equal(saved.runtime.effects.previous.results[1].status, 'pending');
    const beforeBatchRestore = calls;
    await manager.close();
    manager = makeManager();
    await manager.load();
    assert.equal(
      calls,
      beforeBatchRestore,
      'restore never replays the saved tail',
    );
    assert.equal(current().task?.status, 'paused');
    assert.equal(room.blocks.has('3,3,2'), false);
    console.log(
      'PASS: private chat = one call; explicit task advances and verifies real edits; private report isolation; fixed/random one-step polling; unchanged waits cost zero calls; pause/resume/cancel preserve identity; budgets stop loops; chat pause aborts inference; persisted progress restores without inference; multi-action success, middle failure, blocked movement, mid-batch pause and restart without replay. No cloud calls.',
    );
  }
} finally {
  await human?.close();
  await other?.close();
  await manager?.close();
  await server?.close();
  await rm(dir, { recursive: true, force: true });
}
