import { toolResponse } from '../../../../tests/support/pi-response';
import {
  MemoryProviderRepository,
  TestVoiceServiceStore as VoiceServiceStore,
} from '../helpers/memory-storage';
import { createTestServer } from '../helpers/test-server';
/** Isolated UI acceptance world: no dotenv, no production config and no paid model calls. */
import { AgentRunner, Session, until } from '@voxel/agent-runtime';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AICharacterManager } from '../../src/modules/ai-characters';
import { bootstrapProviders } from '../../src/modules/providers';

process.env.DATABASE_URL = '';
process.env.WEB_ORIGIN = 'http://127.0.0.1:5189';
const dir = await mkdtemp(join(tmpdir(), 'agent-console-'));
let server: Awaited<ReturnType<typeof createTestServer>> | undefined;
let manager: AICharacterManager | undefined;
let calls = 0;
try {
  const providers = new MemoryProviderRepository();
  await bootstrapProviders(providers);
  await providers.save(
    {
      name: 'DeepSeek',
      type: 'deepseek',
      apiKey: 'fixture-only',
      defaultModel: 'deepseek-flash',
    },
    'deepseek',
  );
  const voices = new VoiceServiceStore();
  await voices.load();
  server = await createTestServer({
    directory: dir,
    providers,
    voiceServices: voices,
    port: 2589,
    origin: process.env.WEB_ORIGIN,
    agentDependencies: {
      session: (url) => new Session(url),
      runner: () =>
        new AgentRunner(undefined, async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init?.body));
          const input = body.messages
            .filter((m: { role: string }) => m.role === 'user')
            .at(-1)?.content;
          const text = typeof input === 'string' ? input : input?.[0]?.text;
          const context = JSON.parse(text || '{}');
          if (context.currentRequest)
            return toolResponse([
              { name: 'reply', arguments: { text: '你好，我在这里。' } },
            ]);
          const goal = context.previous?.task?.goal ?? '';
          return toolResponse(
            goal.includes('等待') || goal.includes('循环')
              ? [
                  {
                    name: 'wait_for',
                    arguments: {
                      condition: 'world',
                      reason: '已观察附近环境，等待下一步安排。',
                    },
                  },
                ]
              : [
                  {
                    name: 'complete_task',
                    arguments: { summary: '已观察附近环境。' },
                  },
                ],
          );
        }),
    },
  });
  manager = server.characters;
  const app = server.app;
  app.get('/fixture-status', (_req, res) =>
    res.json({ calls, characters: manager!.list() }),
  );
  const a = manager.create({
    providerId: 'deepseek',
    model: 'fixture-model',
    name: '林间向导',
    goal: '',
  });
  const b = manager.create({
    providerId: 'deepseek',
    model: 'fixture-model',
    name: '营地建筑师',
    permissions: { move: true, chat: true, place: true, remove: true },
  });
  await until(
    () => manager!.list().filter((j) => j.status === 'idle').length === 2,
  );
  await manager.tasks.createTaskPlan(b.id, {
    name: '等待附近环境变化',
    goal: '等待附近环境变化',
    timing: { kind: 'immediate' },
    timeZone: 'UTC',
  });
  await until(
    () => manager!.list().find((j) => j.id === b.id)?.status === 'idle',
  );
  manager.stop(a.id);
  await until(
    () => manager!.list().find((j) => j.id === a.id)?.status === 'stopped',
  );
  console.log(
    `Agent console sandbox ready: backend 2589, frontend origin 5189. Temporary data only. ${b.id}`,
  );
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
} finally {
  await manager?.close();
  await server?.close();
  await rm(dir, { recursive: true, force: true });
}
