/** Real local model acceptance, isolated world and fixture-only provider store. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTestServer } from '../helpers/test-server';
import { AgentRunner, Session, until, delay } from '@voxel/agent-runtime';
import { key } from '@voxel/shared';

const output = resolve(
  process.env.EVENTS_OUTPUT ?? '../../output/unified-events/live-model.json',
);
const results: unknown[] = [];
let calls = 0;
const server = await createTestServer({
  agentDependencies: {
    session: (url) => new Session(url),
    runner: (_config, endpoint) => ({
      run: (options) =>
        new AgentRunner(endpoint, async (url, init) => {
          assert(++calls <= 24, 'Real model acceptance bounded to 24 requests');
          const response = await fetch(url, init);
          const reply = await response
            .clone()
            .json()
            .catch(() => ({}));
          console.log(
            JSON.stringify({
              call: calls,
              tools: reply.message?.tool_calls,
              text: reply.message?.content,
            }),
          );
          return response;
        }).run(options),
    }),
  },
});
let human: Session | undefined;
try {
  await server.providers.save(
    {
      name: 'Isolated Ollama',
      type: 'ollama',
      apiKey: '',
      baseUrl: process.env.EVENTS_MODEL_URL ?? 'http://127.0.0.1:11434/v1',
      defaultModel: process.env.EVENTS_MODEL ?? 'qwen3:8b',
    },
    'ollama',
  );
  const role = server.characters.create({
    providerId: 'ollama',
    name: '验收角色',
    intervalMs: 1000,
    maxTurns: 12,
    tokenBudget: 100000,
    taskTimeoutMs: 300000,
    permissions: { move: true, chat: true, place: true, remove: true },
    voiceReplies: false,
  });
  const view = () => server.characters.list().find((c) => c.id === role.id)!;
  await until(() => view().status === 'idle' && !!view().sessionId, 10000);
  human = await new Session(server.url).join('验收玩家', 'human');
  const world = server.world;
  world.blocks.clear();
  for (let x = -12; x <= 12; x++)
    for (let z = -12; z <= 12; z++)
      for (let y = 0; y <= 2; y++)
        world.blocks.set(key({ x, y, z }), { x, y, z, material: 'stone' });
  const actor = world.state.players.get(view().sessionId!)!;
  const leader = world.state.players.get(human.room.sessionId)!;
  Object.assign(actor, { x: 0, y: 2.55, z: -2 });
  Object.assign(leader, { x: -2, y: 2.55, z: -2 });
  world.state.revision++;
  await delay(300);
  const say = async (text: string) =>
    assert(
      (
        await human!.request('chat', {
          text,
          scope: 'private',
          recipients: [view().sessionId],
        })
      ).ok,
    );
  await say(
    '请在最小角 (0,3,0) 建造一座木屋，宽3格、深3格、高4格，门朝北。建好后确认完成。',
  );
  await until(() => calls > 0 && view().status === 'idle', 300000);
  results.push({
    case: 'chat-house',
    task: view().task,
    usage: view().usage,
    block: world.blocks.get('0,3,0'),
    calls,
  });
  assert.equal(world.blocks.get('0,3,0')?.material, 'wood');
  assert.equal(
    world.blocks.get('1,6,1')?.material,
    'wood',
    'roof must really exist',
  );
  assert(
    [...world.blocks.values()].filter((b) => b.material === 'wood').length >=
      20,
    'must build the house, not a single block',
  );
  assert.equal(view().task?.status, 'completed');
  // A once-plan uses precisely the same Pi tools without any conversation handoff.
  await server.characters.tasks.createTaskPlan(role.id, {
    name: '计划建造',
    goal: '在 (4,3,0) 放置一个木方块，然后确认完成。只做这一块的建造。',
    timing: { kind: 'once', at: Date.now() + 1200 },
    timeZone: 'UTC',
    limitsMode: 'inherit',
  });
  await until(
    () =>
      world.blocks.get('4,3,0')?.material === 'wood' &&
      view().task?.status === 'completed',
    300000,
  );
  results.push({
    case: 'scheduled-build',
    task: view().task,
    usage: view().usage,
    calls,
  });
  await say('请持续跟随我，保持 1.5 格距离，不要结束跟随任务。');
  await until(
    () =>
      !!server.characters.jobs.get(role.id)?.memory.effects.follow &&
      view().status === 'idle',
    300000,
  );
  const identity = view().task!.startedAt;
  const beforeFollow = calls;
  Object.assign(leader, { x: 5, y: 2.55, z: -2 });
  await until(
    () => Math.hypot(actor.x - leader.x, actor.z - leader.z) < 2.2,
    20000,
  );
  await delay(2500);
  assert.equal(calls, beforeFollow, 'Navigation ticks must not call the model');
  const beforeQuestion = calls;
  const replyCount = human.events.filter(
    (e) => e.type === 'chat' && e.actor === view().sessionId,
  ).length;
  await say('你好，你叫什么名字？');
  await until(() => calls > beforeQuestion && view().status === 'idle', 150000);
  assert(
    human.events.filter(
      (e) => e.type === 'chat' && e.actor === view().sessionId,
    ).length > replyCount,
    'The player must actually receive a reply',
  );
  assert.equal(view().task!.startedAt, identity);
  await say('停止');
  await until(
    () => view().task?.status === 'paused' && view().status === 'idle',
    10000,
  );
  const stopped = { x: actor.x, z: actor.z };
  Object.assign(leader, { x: -5, z: -2 });
  const stoppedCalls = calls;
  await delay(2500);
  assert(Math.hypot(actor.x - stopped.x, actor.z - stopped.z) < 0.08);
  assert.equal(calls, stoppedCalls);
  results.push({
    case: 'follow-chat-stop',
    task: view().task,
    position: stopped,
    calls,
    usage: view().usage,
  });
  console.log(
    'PASS: real model chat house, scheduled build, follow, chat during follow, immediate stop',
  );
} catch (error) {
  results.push({
    error: String(error),
    roles: server.characters.list().map((c) => ({
      task: c.task,
      lastResponse: c.lastResponse,
      logEntries: c.logEntries.slice(-8),
      exchanges: server.characters.jobs.get(c.id)?.memory.conversation
        .exchanges,
    })),
  });
  throw error;
} finally {
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        model: process.env.EVENTS_MODEL ?? 'qwen3:8b',
        world: 'isolated temporary world',
        results,
      },
      null,
      2,
    ),
  );
  await human?.close();
  await server.close();
}
