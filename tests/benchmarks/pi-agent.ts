import { AgentRunner, emptyState, newTask } from '@voxel/agent-runtime/testing';
import { AgentAttention } from '../../packages/agent-runtime/src/world/observe/attention';

import type { AgentSession } from '@voxel/agent-runtime';
import { type Observation, type RuntimeState } from '@voxel/agent-runtime';
import type { Edit } from '@voxel/shared';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { SavedProvider } from '../../apps/server/src/modules/providers';
import { testAgentConfig } from '../support/agent-config';
// Opt-in: this benchmark sends real requests using a locally configured provider.
const providerFile = process.env.PI_BENCHMARK_PROVIDERS;
if (!providerFile)
  throw new Error(
    'Set PI_BENCHMARK_PROVIDERS to an explicit benchmark provider fixture.',
  );
const providers = JSON.parse(await readFile(providerFile, 'utf8'));
const provider = providers.find((p: SavedProvider) =>
  process.env.PI_BENCHMARK_PROVIDER
    ? p.id === process.env.PI_BENCHMARK_PROVIDER
    : p.type === 'deepseek',
);
if (!provider)
  throw new Error(
    'Configure PI_BENCHMARK_PROVIDERS / PI_BENCHMARK_PROVIDER first.',
  );
const output =
  process.env.PI_BENCHMARK_OUTPUT || 'artifacts/pi-migration/pi-benchmark.json';
await mkdir(dirname(output), { recursive: true });
const config = {
  ...testAgentConfig({ apiKey: provider.apiKey }),
  model: provider.defaultModel,
  maxTurns: 12,
  tokenBudget: 30000,
  timeoutMs: 60000,
  taskTimeoutMs: 180000,
  permissions: { move: true, chat: true, place: true, remove: true },
  maxTokens: 1500,
  thinking: 'disabled' as const,
};
const cases = ['chat', 'move', 'build', 'correction', 'wait', 'update'];
const results: {
  name: string;
  repeat: number;
  success: boolean;
  ms: number;
  usage: RuntimeState['character']['usage'];
  status: string | undefined;
}[] = [];
for (const name of cases)
  for (let repeat = 0; repeat < 5; repeat++) {
    const o: Observation = {
      id: 'world',
      revision: 1,
      radius: 8,
      self: {
        id: 'agent',
        name: 'Assistant',
        kind: 'ai-agent',
        connected: true,
        x: 0,
        y: 2.5,
        z: 0,
        yaw: 0,
      },
      players: [],
      blocks: [],
      events: [],
      allowedActions: ['observe', 'chat', 'move', 'edit'],
    };
    for (let x = -4; x <= 4; x++)
      for (let z = -4; z <= 4; z++)
        o.blocks.push({ x, y: 2, z, material: 'stone' });
    const chats: string[] = [];
    let failed = false,
      moved = false,
      changed = false;
    const attention = new AgentAttention();
    let seq = 0;
    const message = (text: string) =>
      attention.push(
        {
          seq: ++seq,
          at: Date.now(),
          type: 'chat',
          actor: 'human',
          actorKind: 'human',
          data: {
            kind: 'text',
            scope: 'private',
            recipients: ['agent'],
            name: 'Player',
            text,
          },
        },
        'agent',
      );
    const session = {
      observe: async () => structuredClone(o),
      move: (x: number, z: number) => {
        o.self.x += x * 0.1;
        o.self.z += z * 0.1;
        moved ||= !!(x || z);
      },
      request: async (type: string, input?: unknown) => {
        const p = input as Edit & { text: string };
        if (type === 'observe') return structuredClone(o);
        if (type === 'chat') chats.push(p.text);
        if (type === 'edit') {
          if (name === 'correction' && !failed) {
            failed = true;
            return {
              ok: false,
              error: 'Revision conflict; observe and retry.',
              revision: ++o.revision,
              id: 'r',
            };
          }
          const i = o.blocks.findIndex(
            (b) => b.x === p.x && b.y === p.y && b.z === p.z,
          );
          if (i >= 0) o.blocks.splice(i, 1);
          if (p.material)
            o.blocks.push({ x: p.x, y: p.y, z: p.z, material: p.material });
          o.revision++;
        }
        return { ok: true, revision: o.revision, id: 'r' };
      },
    };
    const goals: Record<string, string> = {
      chat: '你好，请简单打个招呼，不需要做其他事情。',
      move: '向世界坐标正 x 方向移动一小步，确认位置变化后完成，不要建造。',
      build: '在 (2,3,0) 和 (3,3,0) 各放一个木头方块，确认后完成。',
      correction:
        '在 (2,3,0) 放一个木头方块；若发生版本冲突，重新观察后重试。确认后完成。',
      wait: '等待世界中有玩家出现。在没有玩家时保持等待，不要移动或建造。',
      update: '在 (2,3,0) 放一个木头方块，然后等待我进一步指示。',
    };
    const memory: RuntimeState = emptyState();
    if (name === 'chat') message(goals[name]);
    else memory.execution.task.current = newTask(goals[name], 'human', 'human');
    const runner = new AgentRunner(provider, fetch);
    const start = performance.now();
    try {
      for (let i = 0; i < 15; i++) {
        await runner.run({
          session: {
            ...session,
            request: session.request as AgentSession['request'],
          },
          config,
          signal: new AbortController().signal,
          memory,
          attention,
        });
        if (
          name === 'update' &&
          !changed &&
          o.blocks.some((b) => b.x === 2 && b.y === 3)
        ) {
          message(
            '修改任务：不要继续放木头。现在在 (3,3,0) 放一个石头方块，确认后完成。',
          );
          changed = true;
        }
        if (
          !attention.pending &&
          !['running'].includes(memory.execution.task.current?.status ?? '')
        )
          break;
      }
    } catch {
      // A failed run is recorded by the success criteria below.
    }
    const at = (x: number, m: string) =>
      o.blocks.some(
        (b) => b.x === x && b.y === 3 && b.z === 0 && b.material === m,
      );
    const success =
      name === 'chat'
        ? chats.length > 0 && !memory.execution.task.current
        : name === 'move'
          ? moved && memory.execution.task.current?.status === 'completed'
          : name === 'build'
            ? at(2, 'wood') &&
              at(3, 'wood') &&
              memory.execution.task.current?.status === 'completed'
            : name === 'correction'
              ? failed &&
                at(2, 'wood') &&
                memory.execution.task.current?.status === 'completed'
              : name === 'wait'
                ? memory.execution.task.current?.status === 'waiting' && !moved
                : changed &&
                  at(3, 'stone') &&
                  memory.execution.task.current?.status === 'completed';
    const result = {
      name,
      repeat,
      success,
      ms: Math.round(performance.now() - start),
      usage: memory.character.usage,
      status: memory.execution.task.current?.status,
    };
    results.push(result);
    console.log(JSON.stringify(result));
    await writeFile(
      output,
      JSON.stringify(
        {
          engine: 'pi',
          model: config.model,
          limits: {
            calls: config.maxTurns,
            tokens: config.tokenBudget,
            timeoutMs: config.taskTimeoutMs,
          },
          world: 'isolated fixed in-memory session; real provider',
          results,
        },
        null,
        2,
      ),
    );
  }
