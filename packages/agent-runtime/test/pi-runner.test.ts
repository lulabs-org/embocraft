import { emptyState } from '@voxel/agent-runtime';
import type { AgentSession, AgentAction, Result } from '@voxel/agent-runtime';
import type { Edit } from '@voxel/shared';
import { describe, it, expect, vi } from 'vitest';
import {
  AgentRunner,
  AgentAttention,
  newTask,
  restoreCheckpoint,
  type AgentRunState,
  type Observation,
} from '@voxel/agent-runtime';
import { testAgentConfig } from '../../../tests/support/agent-config';
import { toolResponse } from '../../../tests/support/pi-response';
const complete = () => ({
  name: 'complete_task',
  arguments: { summary: '进展' },
});
const blocked = () => ({
  name: 'report_blocked',
  arguments: { reason: '进展' },
});
const reply = (text = '你好') => ({ name: 'reply', arguments: { text } });
const start = (goal: string, text?: string) => ({
  name: 'start_task',
  arguments: { goal, reply: text },
});
const revise = (goal: string) => ({ name: 'revise_task', arguments: { goal } });
const chat = (text = '你好') => ({ name: 'chat', arguments: { text } });
const move = {
  name: 'goto',
  arguments: { x: 1, y: 2.5, z: 0 },
};
// These tests isolate Pi lifecycle policy. Navigation physics is exercised in src/world/nav/controller.test.ts.
vi.mock('../src/world/nav/controller', async (original) => ({
  ...(await original<typeof import('../src/world/nav/controller')>()),
  navigate: async (session: AgentSession, action: AgentAction) => {
    session.move(1, 0, false);
    session.move(0, 0, false);
    const fresh = await session.request<Observation>('observe');
    return {
      ok: true,
      status: 'arrived',
      note: 'fixture arrival',
      position: fresh.self,
      target: action,
      replans: 0,
    };
  },
}));
function fixture(replies: { name: string; arguments: unknown }[][]) {
  const config = {
    ...testAgentConfig({ apiKey: 'test-secret' }),
    permissions: { move: true, chat: true, place: true, remove: true },
    maxTurns: 12,
    timeoutMs: 1000,
    taskTimeoutMs: 10000,
  };
  const world: Observation = {
    id: 'o',
    revision: 1,
    radius: 8,
    self: {
      id: 'ai',
      name: 'AI',
      kind: 'ai-agent',
      connected: true,
      x: 0,
      y: 2.5,
      z: 0,
      yaw: 0,
    },
    players: [],
    blocks: [{ x: 1, y: 2, z: 0, material: 'stone' }],
    events: [],
    allowedActions: [],
  };
  const memory: AgentRunState = {
    ...emptyState(),
    task: { current: newTask('向东移动') },
  };
  const attention = new AgentAttention();
  const session = {
    observe: vi.fn(async () => structuredClone(world)),
    move: vi.fn((x: number, z: number) => {
      world.self.x += x * 0.1;
      world.self.z += z * 0.1;
    }),
    request: vi.fn(
      async (type: string, input?: unknown): Promise<Observation | Result> => {
        const p = input as Edit;
        if (type === 'observe') return structuredClone(world);
        if (type === 'edit') {
          world.blocks = world.blocks.filter(
            (b) => b.x !== p.x || b.y !== p.y || b.z !== p.z,
          );
          if (p.material)
            world.blocks.push({ x: p.x, y: p.y, z: p.z, material: p.material });
          world.revision++;
        }
        return { ok: true, id: 'r', revision: world.revision };
      },
    ),
  };
  let index = 0;
  const request = vi.fn<typeof fetch>(async () =>
    toolResponse(replies[index++] ?? [blocked()]),
  );
  const abort = new AbortController();
  const checkpoint = vi.fn(async () => {});
  const run = () =>
    new AgentRunner(undefined, request).run({
      session: {
        ...session,
        request: session.request as AgentSession['request'],
      },
      config,
      signal: abort.signal,
      memory,
      attention,
      checkpoint,
    });
  let sequence = 0;
  const message = (scope = 'private', actor = 'human', text = '你好') =>
    attention.push(
      {
        seq: ++sequence,
        at: Date.now(),
        type: 'chat',
        actor,
        actorKind: 'human',
        data: {
          scope,
          kind: 'text',
          text,
          name: 'Player',
          recipients: ['ai'],
        },
      },
      'ai',
    );
  return {
    config,
    world,
    memory,
    attention,
    session,
    request,
    abort,
    checkpoint,
    run,
    message,
  };
}
describe('Pi world tool runtime', () => {
  it('runs more than three actual model requests within one wake and confirms completion', async () => {
    const f = fixture([[move], [move], [move], [move], [chat(), complete()]]);
    await f.run();
    expect(f.request).toHaveBeenCalledTimes(5);
    expect(f.memory.task.current?.status).toBe('completed');
    expect(f.memory.task.usage).toEqual({
      calls: 5,
      tokens: 500,
      estimated: false,
    });
    expect(f.memory.task.current?.calls).toBe(5);
    expect(f.memory.checkpoint.pi).toBeUndefined();
  });
  it('returns tool validation failures for correction and skips the remainder of that batch', async () => {
    const f = fixture([
      [{ name: 'goto', arguments: { x: 99 } }, chat('must not send')],
      [move],
      [complete()],
    ]);
    await f.run();
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.session.request).not.toHaveBeenCalledWith(
      'chat',
      expect.anything(),
    );
    expect(f.memory.task.current?.status).toBe('completed');
  });
  it('checks each request budget, permits effects of the last admitted request, and stops with no hidden retry', async () => {
    const f = fixture([[move], [move], [move]]);
    f.config.maxTurns = 2;
    await f.run();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.world.self.x).toBeCloseTo(0.2);
    expect(f.memory.task.current?.status).toBe('budget');
    expect(f.memory.task.current?.calls).toBe(2);
  });
  it('waiting is terminal within the batch and unchanged polling costs no requests', async () => {
    const f = fixture([
      [
        {
          name: 'wait_for',
          arguments: { condition: 'players', reason: '等玩家' },
        },
        move,
      ],
    ]);
    await f.run();
    expect(f.memory.task.current?.status).toBe('waiting');
    expect(f.session.move).not.toHaveBeenCalled();
    await f.run();
    expect(f.request).toHaveBeenCalledTimes(1);
    f.world.players = [{ ...f.world.self, id: 'human' }];
    await f.run();
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('isolates a public question from private task history and keeps the private task intact', async () => {
    const f = fixture([[reply('公开回复')]]);
    f.memory.task.current = {
      ...newTask('PRIVATE SECRET', 'alice', 'alice'),
      status: 'waiting',
      waitFor: 'players',
    };
    f.memory.checkpoint.pi = {
      version: 1,
      taskStartedAt: f.memory.task.current.startedAt,
      audience: 'alice',
      messages: [],
    };
    f.memory.health.waitSignature = '[]';
    f.message('public', 'bob');
    await f.run();
    const body = String(f.request.mock.calls[0][1]!.body);
    expect(body).not.toContain('PRIVATE SECRET');
    expect(f.memory.task.current.goal).toBe('PRIVATE SECRET');
    expect(f.memory.task.current.status).toBe('waiting');
    expect(f.memory.task.current.calls).toBe(0);
  });
  it('forces private routing and transfers initial message requests into a new task', async () => {
    const f = fixture([[start('走一步')], [move], [chat(), complete()]]);
    Reflect.deleteProperty(f.memory.task, 'current');
    f.message();
    await f.run();
    expect(f.memory.task.current).toMatchObject({
      goal: '走一步',
      owner: 'human',
      privateTo: 'human',
      calls: 3,
      tokens: 300,
      status: 'completed',
    });
    expect(f.session.request).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ scope: 'private', recipients: ['human'] }),
    );
  });
  it('rejects another player taking over the task', async () => {
    const f = fixture([[revise('stolen'), move], [reply()]]);
    f.memory.task.current = {
      ...newTask('owned', 'alice', 'alice'),
      status: 'paused',
    };
    f.message('private', 'bob');
    await f.run();
    expect(f.memory.task.current.goal).toBe('owned');
    expect(f.session.move).not.toHaveBeenCalled();
  });
  it('does not send requests or effects after cancellation', async () => {
    const f = fixture([[move]]);
    f.abort.abort();
    await expect(f.run()).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.session.move).not.toHaveBeenCalled();
  });
  it('stops before a world write when checkpoint persistence fails', async () => {
    const f = fixture([[move], [complete()]]);
    let writes = 0;
    f.checkpoint.mockImplementation(async () => {
      if (f.memory.checkpoint.pi?.inFlight && ++writes === 1)
        throw Error('disk full');
    });
    await expect(f.run()).rejects.toThrow('检查点');
    expect(f.session.move).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('prevents concurrent runs for the same Agent state', async () => {
    const f = fixture([[move], [complete()]]);
    const first = f.run();
    await expect(f.run()).rejects.toThrow('已在运行');
    await first;
  });
  it('yields at tool boundary when another human message arrives', async () => {
    const f = fixture([[move, move], [reply()], [complete()]]);
    f.session.move.mockImplementation((x) => {
      if (x) {
        f.world.self.x += 0.1;
        f.message();
      }
    });
    await f.run();
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.attention.pending).toBe(false);
    expect(f.world.self.x).toBeCloseTo(0.1);
  });
  it('cannot finish in the same model turn as a world mutation', async () => {
    const f = fixture([[move, complete()], [complete()]]);
    await f.run();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.memory.task.current?.status).toBe('completed');
  });
  it('halts a repeated no-progress loop', async () => {
    const f = fixture(
      Array.from({ length: 8 }, () => [{ name: 'observe', arguments: {} }]),
    );
    await f.run();
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.memory.task.current?.status).toBe('blocked');
  });
  it('treats a refreshed observation as progress instead of the stale decision snapshot', async () => {
    const edits = Array.from({ length: 8 }, (_, index) => [
      {
        name: 'edit',
        arguments: { x: index - 4, y: 3, z: 0, material: 'wood' },
      },
    ]);
    const f = fixture(edits);
    await f.run();
    expect(f.request).toHaveBeenCalledTimes(9);
    expect(f.memory.task.current?.status).toBe('blocked');
  });
  it('restores unknown in-flight effects without replaying or keeping incomplete tool groups', () => {
    const f = fixture([]);
    f.memory.checkpoint.pi = {
      version: 1,
      taskStartedAt: f.memory.task.current!.startedAt,
      audience: 'public',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'x',
              name: 'chat',
              arguments: { text: 'hi' },
            },
          ],
          stopReason: 'toolUse',
        } as NonNullable<AgentRunState['checkpoint']['pi']>['messages'][number],
      ],
      inFlight: { id: 'x', name: 'chat', state: 'executing' },
    };
    restoreCheckpoint(f.memory);
    expect(f.memory.checkpoint.unknownEffect?.state).toBe('unknown');
    expect(f.memory.checkpoint.pi).toBeUndefined();
    expect(f.memory.version).toBe(3);
  });
});

describe('Pi provider and recovery boundaries', () => {
  const nativeResponse = (
    tools: { name: string; arguments: unknown }[] = [],
    content = '',
  ) =>
    new Response(
      JSON.stringify({
        done: true,
        done_reason: 'stop',
        message: {
          role: 'assistant',
          content,
          tool_calls: tools.map((tool) => ({ function: tool })),
        },
        prompt_eval_count: 90,
        eval_count: 10,
      }),
    );
  const localEndpoint = {
    type: 'ollama' as const,
    baseUrl: 'http://localhost:11434/v1',
  };
  it('corrects one prose completion without replaying an acknowledged edit', async () => {
    const f = fixture([]);
    const responses = [
      nativeResponse([
        { name: 'edit', arguments: { x: 2, y: 3, z: 0, material: 'wood' } },
      ]),
      nativeResponse([], 'done'),
      nativeResponse([complete()]),
    ];
    const request = vi.fn<typeof fetch>(async () => responses.shift()!);
    await new AgentRunner(localEndpoint, request).run({
      session: {
        ...f.session,
        request: f.session.request as AgentSession['request'],
      },
      config: f.config,
      signal: f.abort.signal,
      memory: f.memory,
    });
    expect(f.memory.task.current?.status).toBe('completed');
    expect(f.memory.task.current?.calls).toBe(3);
    expect(
      f.session.request.mock.calls.filter(([name]) => name === 'edit'),
    ).toHaveLength(1);
    const lastBody = JSON.parse(String(request.mock.calls[2][1]?.body));
    expect(lastBody.messages.at(-1).content).toContain(
      'Do not repeat successful world actions',
    );
  });
  it('stops after one local protocol correction and never executes prose', async () => {
    const f = fixture([]);
    const request = vi.fn<typeof fetch>(async () =>
      nativeResponse([], 'edit x=2'),
    );
    await new AgentRunner(localEndpoint, request).run({
      session: {
        ...f.session,
        request: f.session.request as AgentSession['request'],
      },
      config: f.config,
      signal: f.abort.signal,
      memory: f.memory,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(f.memory.task.current?.status).toBe('blocked');
    expect(f.memory.task.current?.calls).toBe(2);
    expect(f.session.request.mock.calls.some(([name]) => name === 'edit')).toBe(
      false,
    );
  });
  it('does not bypass the request budget for protocol correction', async () => {
    const f = fixture([]);
    const request = vi.fn<typeof fetch>(async () => nativeResponse([], 'done'));
    await new AgentRunner(localEndpoint, request).run({
      session: {
        ...f.session,
        request: f.session.request as AgentSession['request'],
      },
      config: { ...f.config, maxTurns: 1 },
      signal: f.abort.signal,
      memory: f.memory,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(f.memory.task.current?.calls).toBe(1);
    expect(f.memory.task.current?.status).toBe('budget');
  });
  it.each(['ollama', 'compatible', 'deepseek'] as const)(
    'uses %s configuration without hidden JSON mode or environment credentials',
    async (type) => {
      const f = fixture([]);
      const request = vi.fn<typeof fetch>(async () =>
        type === 'ollama'
          ? new Response(
              JSON.stringify({
                done: true,
                done_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      function: {
                        name: 'complete_task',
                        arguments: { summary: '进展' },
                      },
                    },
                  ],
                },
                prompt_eval_count: 90,
                eval_count: 10,
              }),
            )
          : toolResponse([complete()]),
      );
      await new AgentRunner(
        {
          type,
          baseUrl:
            type === 'deepseek'
              ? 'https://api.deepseek.com'
              : 'http://localhost:11434/v1',
        },
        request,
      ).run({
        session: {
          ...f.session,
          request: f.session.request as AgentSession['request'],
        },
        config: f.config,
        signal: f.abort.signal,
        memory: f.memory,
      });
      const [url, init] = request.mock.calls[0];
      expect(String(url)).toBe(
        type === 'ollama'
          ? 'http://localhost:11434/api/chat'
          : type === 'deepseek'
            ? 'https://api.deepseek.com/chat/completions'
            : 'http://localhost:11434/v1/chat/completions',
      );
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer test-secret',
      );
      const body = JSON.parse(init!.body as string);
      expect(body.response_format).toBeUndefined();
      expect(body.stream).toBe(type !== 'ollama');
      if (type === 'ollama') {
        expect(body.think).toBe(false);
        expect(body.options).toMatchObject({
          num_ctx: 32768,
          num_predict: f.config.maxTokens,
        });
      } else {
        expect(body.tool_choice).toBe('required');
        expect(body.max_tokens).toBe(f.config.maxTokens);
      }
      if (type === 'deepseek')
        expect(body.thinking).toEqual({ type: 'disabled' });
      else expect(body.thinking).toBeUndefined();
    },
  );
  it('charges HTTP errors once and persists only redacted errors', async () => {
    const f = fixture([]);
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response('test-secret private upstream body', { status: 401 }),
    );
    await new AgentRunner(undefined, request).run({
      session: {
        ...f.session,
        request: f.session.request as AgentSession['request'],
      },
      config: f.config,
      signal: f.abort.signal,
      memory: f.memory,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(f.memory.task.current).toMatchObject({
      calls: 1,
      status: 'blocked',
      estimated: true,
    });
    expect(f.memory.task.current!.tokens).toBeGreaterThan(0);
    expect(JSON.stringify(f.memory)).not.toContain('test-secret');
    expect(JSON.stringify(f.memory)).not.toContain('upstream body');
  });
  it('does not reset an exhausted task budget via an incoming update', async () => {
    const f = fixture([[revise('same task'), move]]);
    f.memory.task.current!.owner = 'human';
    f.memory.task.current!.privateTo = 'human';
    f.memory.task.current!.calls = f.config.maxTurns;
    f.message();
    await f.run();
    expect(f.session.move).not.toHaveBeenCalled();
    expect(f.memory.task.current?.status).toBe('budget');
    expect(f.memory.task.current!.calls).toBeGreaterThanOrEqual(
      f.config.maxTurns,
    );
  });
  it('new goal control resets stale no-progress counters without resetting budgets', async () => {
    const f = fixture([[revise('new destination')], [move], [complete()]]);
    f.memory.task.current!.owner = 'human';
    f.memory.task.current!.privateTo = 'human';
    f.memory.task.current!.status = 'waiting';
    f.memory.task.current!.waitFor = 'players';
    f.memory.health.noProgress = 2;
    f.message();
    await f.run();
    expect(f.memory.task.current?.status).toBe('completed');
    expect(f.memory.task.current?.calls).toBe(3);
  });
  it('retains only eight complete turns and preserves task identity on restart', async () => {
    const f = fixture([
      ...Array.from({ length: 10 }, () => [move]),
      [
        {
          name: 'wait_for',
          arguments: { condition: 'players', reason: '等待' },
        },
      ],
    ]);
    await f.run();
    expect(f.request).toHaveBeenCalledTimes(11);
    expect(
      f.memory.checkpoint.pi?.messages.filter(
        (m) => (m as { role: string }).role === 'assistant',
      ),
    ).toHaveLength(8);
    const restored = JSON.parse(JSON.stringify(f.memory));
    restoreCheckpoint(restored);
    expect(restored.checkpoint.pi).toEqual(f.memory.checkpoint.pi);
    expect(restored.task.current?.startedAt).toBe(
      f.memory.task.current?.startedAt,
    );
  });
  it('different Agents can execute concurrently without shared histories or tools', async () => {
    const a = fixture([[move], [complete()]]),
      b = fixture([[chat('独立回复'), complete()]]);
    await Promise.all([a.run(), b.run()]);
    expect(a.session.request).not.toHaveBeenCalledWith(
      'chat',
      expect.anything(),
    );
    expect(b.session.move).not.toHaveBeenCalled();
    expect(a.memory.task.usage?.calls).toBe(2);
    expect(b.memory.task.usage?.calls).toBe(1);
  });
});

it('an explicitly classified greeting completes in one request without changing a task', async () => {
  const f = fixture([[reply()]]);
  Reflect.deleteProperty(f.memory.task, 'current');
  f.message();
  await f.run();
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.memory.task.current).toBeUndefined();
  expect(f.session.request).toHaveBeenCalledExactlyOnceWith(
    'chat',
    expect.objectContaining({ scope: 'private', recipients: ['human'] }),
  );
});
it('routes the current message without terrain or an obsolete completion receipt', async () => {
  const f = fixture([[reply()]]);
  f.memory.task.current!.status = 'completed';
  f.memory.task.current!.summary = 'obsolete-completion-marker';
  f.message('private', 'new-sender', '请到我这里来');
  await f.run();
  const body = JSON.parse(String(f.request.mock.calls[0][1]?.body));
  const input = JSON.parse(body.messages[1].content[0].text);
  expect(input.currentRequest).toEqual({
    actor: 'new-sender',
    text: '请到我这里来',
  });
  expect(input.observation.blocks).toEqual([]);
  expect(input.task).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain('obsolete-completion-marker');
  expect(f.memory.task.current?.status).toBe('completed');
});
it('explicit unlimited task settings do not create an invalid deadline', async () => {
  const f = fixture([[move], [complete()]]);
  Object.assign(f.config, {
    maxTurns: Infinity,
    tokenBudget: Infinity,
    taskTimeoutMs: Infinity,
  });
  await f.run();
  expect(f.memory.task.current?.status).toBe('completed');
  expect(f.memory.task.current?.calls).toBe(2);
});
it('later chat cannot erase an unresolved world failure and allow completion', async () => {
  const f = fixture([
    [{ name: 'edit', arguments: { x: 1, y: 3, z: 0, material: 'wood' } }],
    [chat('仍在处理'), complete()],
    [blocked()],
  ]);
  f.session.request.mockResolvedValue({
    ok: false,
    id: 'r',
    revision: 1,
    error: 'unsupported',
  });
  await f.run();
  expect(f.memory.task.current?.status).toBe('blocked');
  expect(f.memory.effects.pendingEffects).toBeDefined();
});

it('does not discard an addressed reply when another player message is already queued', async () => {
  const f = fixture([[reply('reply one')], [reply('reply two')]]);
  Reflect.deleteProperty(f.memory.task, 'current');
  f.message('private', 'alice');
  f.message('private', 'bob');
  await f.run();
  await f.run();
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(f.session.request).toHaveBeenCalledWith(
    'chat',
    expect.objectContaining({ text: 'reply one', recipients: ['alice'] }),
  );
  expect(f.session.request).toHaveBeenCalledWith(
    'chat',
    expect.objectContaining({ text: 'reply two', recipients: ['bob'] }),
  );
});

it('persists request admission before sending to the provider', async () => {
  const f = fixture([[complete()]]);
  f.request.mockImplementationOnce(async () => {
    expect(f.checkpoint.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.memory.task.current?.calls).toBe(1);
    return toolResponse([complete()]);
  });
  await f.run();
});
it('charges a cancelled in-flight request once and executes no late effects', async () => {
  const f = fixture([[move]]);
  f.request.mockImplementationOnce(async (_url, options) => {
    f.abort.abort();
    options!.signal!.throwIfAborted();
    return toolResponse([move]);
  });
  await f.run();
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.memory.task.usage).toMatchObject({ calls: 1, estimated: true });
  expect(f.session.move).not.toHaveBeenCalled();
});
it('stops on provider timeout with no hidden retries or effects', async () => {
  const f = fixture([[move]]);
  f.config.timeoutMs = 20;
  f.request.mockImplementationOnce(
    async (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener(
          'abort',
          () => reject(new Error('cancelled')),
          { once: true },
        );
      }),
  );
  await f.run();
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.memory.task.current?.reason).toContain('超时');
  expect(f.memory.task.usage).toMatchObject({ calls: 1, estimated: true });
  expect(f.session.move).not.toHaveBeenCalled();
});
it('never automatically resends unknown chat after recovery', async () => {
  const f = fixture([
    [chat('duplicate')],
    [{ name: 'request_input', arguments: { question: '请确认' } }],
  ]);
  f.memory.checkpoint.pi = {
    version: 1,
    taskStartedAt: f.memory.task.current!.startedAt,
    audience: 'public',
    messages: [],
    inFlight: { id: 'old', name: 'chat', state: 'executing' },
  };
  await f.run();
  expect(f.session.request).not.toHaveBeenCalledWith('chat', expect.anything());
  expect(f.memory.task.current?.status).toBe('needs_input');
});

it('stops repeated world failures even when unrelated world revisions keep changing', async () => {
  const edit = {
    name: 'edit',
    arguments: { x: 1, y: 3, z: 0, material: 'wood' },
  };
  const f = fixture([[edit], [edit], [edit], [edit]]);
  f.session.request.mockImplementation(async (type: string) =>
    type === 'observe'
      ? structuredClone(f.world)
      : { ok: false, error: 'conflict', id: 'r', revision: ++f.world.revision },
  );
  await f.run();
  expect(f.request).toHaveBeenCalledTimes(3);
  expect(f.memory.task.current?.status).toBe('blocked');
  expect(f.memory.health.failures).toBe(3);
});

it('rebuilds task context after a goal update without carrying old tool calls', async () => {
  const f = fixture([
    [chat('task-context-marker')],
    [{ name: 'wait_for', arguments: { condition: 'players', reason: '等待' } }],
    [revise('走一步')],
    [move],
    [complete()],
  ]);
  await f.run();
  f.message();
  await f.run();
  expect(f.request).toHaveBeenCalledTimes(5);
  expect(String(f.request.mock.calls[2][1]!.body)).not.toContain(
    'task-context-marker',
  );
  const taskMessages = JSON.parse(
    String(f.request.mock.calls[3][1]!.body),
  ).messages;
  expect(JSON.stringify(taskMessages)).not.toContain('task-context-marker');
  expect(JSON.stringify(taskMessages)).toContain('revise_task');
  expect(f.memory.task.current?.status).toBe('completed');
});

it('stops the loop if the host cannot durably create a task', async () => {
  const f = fixture([[start('走一步')], [move], [move]]);
  Reflect.deleteProperty(f.memory.task, 'current');
  f.message();
  await expect(
    new AgentRunner(undefined, f.request).run({
      session: {
        ...f.session,
        request: f.session.request as AgentSession['request'],
      },
      config: f.config,
      signal: f.abort.signal,
      memory: f.memory,
      attention: f.attention,
      checkpoint: f.checkpoint,
      hooks: {
        beforeNewTask: async () => {
          throw new Error('disk unavailable');
        },
      },
    }),
  ).rejects.toThrow('检查点');
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.session.move).not.toHaveBeenCalled();
});

it.each(['none', 'cancelled'] as const)(
  'rejects world effects before a task is started with a %s prior task',
  async (prior) => {
    const f = fixture([
      [move, chat('好的，我这就过去！')],
      [start('到玩家这里来')],
      [move],
      [chat('已经到达'), complete()],
    ]);
    if (prior === 'none') Reflect.deleteProperty(f.memory.task, 'current');
    else f.memory.task.current!.status = 'cancelled';
    f.message('private', 'human', '到我这里来');
    await f.run();
    expect(f.request).toHaveBeenCalledTimes(4);
    expect(String(f.request.mock.calls[1][1]!.body)).toContain('chat');
    expect(f.session.request).not.toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ text: '好的，我这就过去！' }),
    );
    // The first goto and the following chat were rejected before any task existed.
    expect(f.world.self.x).toBeCloseTo(0.1);
    expect(f.memory.task.current).toMatchObject({
      goal: '到玩家这里来',
      status: 'completed',
      owner: 'human',
      privateTo: 'human',
    });
    expect(f.session.request).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ text: '已经到达', recipients: ['human'] }),
    );
  },
);

it('a task acknowledgement cannot end the wake before its world action', async () => {
  const f = fixture([
    [start('到我这里来', '我这就过去')],
    [move],
    [complete()],
  ]);
  Reflect.deleteProperty(f.memory.task, 'current');
  f.message('private', 'human', '到我这里来');
  await f.run();
  expect(f.request).toHaveBeenCalledTimes(3);
  expect(f.world.self.x).toBeCloseTo(0.1);
  expect(f.memory.task.current).toMatchObject({ status: 'completed' });
});

it('exposes the same tools to chat and activity events, with durable task creation before effects', async () => {
  const f = fixture([[start('去 human 身边')], [move], [complete()]]);
  Reflect.deleteProperty(f.memory.task, 'current');
  f.message('private', 'human', '到我这里来');
  const saved: AgentRunState[] = [];
  f.checkpoint.mockImplementation(async () => {
    saved.push(structuredClone(f.memory));
  });
  await f.run();
  const bodies = f.request.mock.calls.map(([, init]) =>
    JSON.parse(String(init!.body)),
  );
  const names = (body: { tools: { function: { name: string } }[] }) =>
    body.tools.map((t) => t.function.name);
  expect(names(bodies[0])).toContain('start_task');
  expect(names(bodies[0])).toContain('goto');
  expect(names(bodies[1])).toEqual(names(bodies[0]));
  expect(bodies.every((b) => !names(b).includes('update_task'))).toBe(true);
  expect(
    saved.some(
      (s) =>
        s.task.current?.goal === '去 human 身边' &&
        s.task.current?.calls === 1 &&
        !s.effects.previous,
    ),
  ).toBe(true);
  expect(f.memory.task.current?.calls).toBe(3);
  expect(f.memory.task.usage?.calls).toBe(3);
});

it('supports sequential start and revise commands within the same Pi event', async () => {
  const f = fixture([[start('first'), revise('second')], [complete()]]);
  Reflect.deleteProperty(f.memory.task, 'current');
  f.message();
  await f.run();
  expect(f.memory.task.current?.goal).toBe('second');
  expect(f.memory.task.current?.calls).toBe(2);
});

it('leaves paused task state and checkpoint byte-for-byte intact during ordinary chat', async () => {
  const f = fixture([[reply('我正在休息')]]);
  f.memory.task.current!.status = 'paused';
  f.memory.checkpoint.pi = {
    version: 1,
    taskStartedAt: f.memory.task.current!.startedAt,
    audience: 'public',
    messages: [],
  };
  const before = JSON.stringify([
    f.memory.task.current,
    f.memory.checkpoint.pi,
    f.memory.effects.previous,
  ]);
  f.message();
  await f.run();
  expect(
    JSON.stringify([
      f.memory.task.current,
      f.memory.checkpoint.pi,
      f.memory.effects.previous,
    ]),
  ).toBe(before);
  expect(f.request).toHaveBeenCalledTimes(1);
});

it('resumes a running task after a reply without adding the conversation to task history', async () => {
  const f = fixture([
    [reply('conversation-only-marker')],
    [move],
    [complete()],
  ]);
  f.message();
  await f.run();
  expect(f.memory.task.current?.status).toBe('completed');
  expect(f.memory.task.current?.calls).toBe(2);
  expect(f.memory.task.usage?.calls).toBe(3);
  expect(String(f.request.mock.calls[1][1]!.body)).not.toContain(
    'conversation-only-marker',
  );
});

it('bounds dialogue requests even when task limits are disabled', async () => {
  const f = fixture(Array.from({ length: 20 }, () => [move]));
  Reflect.deleteProperty(f.memory.task, 'current');
  Object.assign(f.config, {
    maxTurns: Infinity,
    tokenBudget: Infinity,
    taskTimeoutMs: Infinity,
  });
  f.message();
  await f.run();
  expect(f.request).toHaveBeenCalledTimes(3);
  expect(f.session.move).not.toHaveBeenCalled();
});

it('permits cancellation at exhausted task budget and charges the command exactly once', async () => {
  const f = fixture([[{ name: 'cancel_task', arguments: {} }]]);
  f.memory.task.current!.calls = f.config.maxTurns;
  f.memory.task.current!.tokens = 50000;
  f.memory.task.current!.status = 'budget';
  f.message();
  await f.run();
  expect(f.memory.task.current).toMatchObject({
    status: 'cancelled',
    calls: 13,
    tokens: 50100,
  });
  expect(f.memory.task.usage?.calls).toBe(1);
  expect(f.session.move).not.toHaveBeenCalled();
});

it('records replies with chat permission disabled and still executes an accepted task', async () => {
  const f = fixture([[start('走一步', '收到')], [move], [complete()]]);
  Reflect.deleteProperty(f.memory.task, 'current');
  f.config.permissions.chat = false;
  f.message();
  await f.run();
  expect(f.memory.task.current?.status).toBe('completed');
  expect(f.memory.health.lastResponse).toBe('收到');
  expect(f.session.request).not.toHaveBeenCalledWith('chat', expect.anything());
});

it('rejects stale model effects after a task revision changes', async () => {
  const f = fixture([[move]]);
  f.request.mockImplementationOnce(async () => {
    f.memory.task.identity!.revision++;
    f.memory.task.current!.status = 'cancelled';
    return toolResponse([move]);
  });
  await f.run();
  expect(f.session.move).not.toHaveBeenCalled();
  expect(f.memory.task.current?.status).toBe('cancelled');
});

it('answers a progress question while a durable build action continues without duplicate edits', async () => {
  const f = fixture([
    [
      {
        name: 'build',
        arguments: { blocks: [{ x: 1, y: 3, z: 0, material: 'wood' }] },
      },
    ],
    [reply('正在施工，进度已保留')],
    [complete()],
  ]);
  f.memory.task.current!.goal = '放置一个木块';
  f.memory.task.current!.owner = 'human';
  f.memory.task.current!.privateTo = 'human';
  const original = f.session.request.getMockImplementation()!;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.session.request.mockImplementation(async (type, payload) => {
    if (type === 'edit') await pending;
    return original(type, payload);
  });
  const run = f.run();
  await vi.waitFor(() =>
    expect(f.session.request).toHaveBeenCalledWith('edit', expect.anything()),
  );
  expect(f.memory.effects.activeAction).toMatchObject({
    name: 'build',
    status: 'running',
  });
  f.message('private', 'human', '进度怎么样？');
  await vi.waitFor(() =>
    expect(f.session.request).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ text: '正在施工，进度已保留' }),
    ),
  );
  expect(f.memory.effects.activeAction?.status).toBe('running');
  release();
  await run;
  expect(
    f.session.request.mock.calls.filter(([type]) => type === 'edit'),
  ).toHaveLength(1);
  expect(f.memory.task.current?.status).toBe('completed');
  expect(
    f.memory.inbox?.events.some(
      (event) => event.kind === 'action_result' && event.state === 'done',
    ),
  ).toBe(true);
});

it('keeps bounded user turns per audience without sharing private conversations', async () => {
  const f = fixture([
    [reply('alice-secret')],
    [reply('bob-answer')],
    [reply('alice-again')],
  ]);
  Reflect.deleteProperty(f.memory.task, 'current');
  f.message('private', 'alice', 'alice-question');
  await f.run();
  f.message('private', 'bob', 'bob-question');
  await f.run();
  expect(String(f.request.mock.calls[1][1]!.body)).not.toContain(
    'alice-secret',
  );
  expect(String(f.request.mock.calls[1][1]!.body)).not.toContain(
    'alice-question',
  );
  f.message('private', 'alice', '还记得吗');
  await f.run();
  expect(String(f.request.mock.calls[2][1]!.body)).toContain('alice-question');
  expect(String(f.request.mock.calls[2][1]!.body)).not.toContain('bob-answer');
});

it('switches from a cancelled activity to a new one without moving old usage or double counting', async () => {
  const f = fixture([
    [{ name: 'cancel_task', arguments: {} }, start('新目标')],
    [move],
    [complete()],
  ]);
  const previous = f.memory.task.current!;
  previous.calls = 5;
  previous.tokens = 500;
  f.message('private', 'human', '停止旧任务，开始新目标');
  await f.run();
  expect(previous.status).toBe('cancelled');
  expect(previous.calls).toBe(6);
  expect(f.memory.task.current?.goal).toBe('新目标');
  expect(f.memory.task.current?.status).toBe('completed');
  expect(f.memory.task.current?.calls).toBe(2);
  expect(f.memory.task.usage?.calls).toBe(3);
});
