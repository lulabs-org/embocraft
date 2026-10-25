import { createTestServer } from '../helpers/test-server';
import { DecisionFixture as ModelPlanner } from './../../../../tests/support/decision-fixture';
import { fixtureRunnerFactory } from './../../../../tests/support/decision-fixture';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AICharacterManager } from '../../src/modules/ai-characters';
import {
  FileProviderRepository,
  bootstrapProviders,
} from '../../src/modules/providers';
import { Session, until, type Observation } from '@voxel/agent-runtime';

import type { AICharacterView } from '@voxel/shared';
process.env.DATABASE_URL = '';
process.env.VOICE_PROVIDER = 'mock';
process.env.WEB_ORIGIN = 'http://127.0.0.1:5187';
const dir = await mkdtemp(join(tmpdir(), 'voxel-manager-'));
let server: Awaited<ReturnType<typeof createTestServer>> | undefined;
let manager: AICharacterManager | undefined;
let calls = 0;
const observations: Observation[] = [];
let speaker: Session | undefined;
const originalFetch = globalThis.fetch;
try {
  const store = new FileProviderRepository(join(dir, 'providers.json'));
  await bootstrapProviders(store, { DEEPSEEK_API_KEY: 'fixture-secret' });
  const rolesInRequests: string[] = [];
  const capabilitiesInRequests: unknown[] = [];
  const request: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init!.body as string);
    capabilitiesInRequests.push(JSON.parse(body.messages[1].content).character);
    rolesInRequests.push(
      JSON.parse(body.messages[1].content).character.roleDescription,
    );
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                actions:
                  JSON.parse(body.messages[1].content).character
                    .roleDescription === 'capability fixture'
                    ? [
                        { type: 'edit', x: 1, y: 3, z: 1, material: 'wood' },
                        { type: 'chat', text: 'Forbidden capability receipt' },
                      ]
                    : [{ type: 'chat', text: 'Managed fixture hello' }],
                task: {
                  intent: 'continue',
                  status: 'completed',
                  summary: '已回复',
                },
              }),
            },
          },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  globalThis.fetch = (async (input, init) => {
    if (typeof input === 'string' && input.includes('api.deepseek.com')) {
      return Response.json({ data: [{ id: 'fixture-model' }] });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  server = await createTestServer({
    directory: dir,
    providers: store,
    origin: process.env.WEB_ORIGIN,
    agentDependencies: {
      session: (url) => new Session(url),
      runner: fixtureRunnerFactory((config, provider) => {
        const planner = new ModelPlanner(config, request, provider);
        const decide = planner.decide.bind(planner);
        planner.decide = (...args) => {
          observations.push(args[0]);
          return decide(...args);
        };
        return planner;
      }),
    },
  });
  manager = server.characters;
  const room = server.world,
    url = server.httpUrl;
  const api = async (
    path: string,
    method = 'GET',
    body?: unknown,
    origin: string | undefined = process.env.WEB_ORIGIN,
  ) =>
    fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: 'Bearer fixture-gateway-token-for-tests',
        ...(origin ? { Origin: origin } : {}),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal(
    (await api('/providers', 'GET', undefined, 'https://untrusted.example'))
      .status,
    403,
  );
  assert.equal((await fetch(`${url}/providers`)).status, 401);
  assert.equal((await api('/providers', 'OPTIONS')).status, 204);
  const missingRoute = await api('/ai-characters/missing/endpoint', 'POST', {});
  assert.equal(missingRoute.status, 404);
  assert.equal(typeof (await missingRoute.json()).error, 'string');
  const missingAgent = await api('/task-runs/nonexistent/resume', 'POST', {});
  assert.equal(missingAgent.status, 404);
  assert.equal(typeof (await missingAgent.json()).error, 'string');
  for (const value of [
    { startTask: true },
    { startTask: false },
    { taskTimeZone: 'UTC' },
    { goal: 'Hidden task' },
  ]) {
    const rejected = await api('/ai-characters', 'POST', {
      providerId: 'deepseek',
      name: 'Rejected',
      ...value,
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /Tasks/);
  }
  assert.equal(manager.list().length, 0);
  assert.equal(manager.plans.plans.length, 0);
  assert.equal(manager.plans.runs.length, 0);
  const publicProviders = await (await api('/providers')).text();
  assert(!publicProviders.includes('fixture-secret'));
  assert(publicProviders.includes('hasApiKey'));
  assert.equal(
    (
      await api('/ai-characters', 'POST', {
        providerId: 'deepseek',
        name: 'AI',
        maxTurns: 1001,
      })
    ).status,
    400,
  );
  assert.equal(
    (await api('/ai-characters', 'POST', { providerId: 'missing' })).status,
    404,
  );
  assert.equal(
    (await api('/providers', 'POST', { name: 'A'.repeat(40000) })).status,
    413,
  );
  assert.equal(calls, 0, 'Configuration must not start inference');
  assert.deepEqual(await (await api('/providers/deepseek/models')).json(), {
    models: ['fixture-model'],
  });
  const customResponse = await api('/providers', 'POST', {
    name: 'Fixture gateway',
    type: 'compatible',
    baseUrl: 'https://fixture.example/v1',
    apiKey: 'fixture-second',
    defaultModel: 'org/model',
  });
  assert.equal(customResponse.status, 201);
  const custom = (await customResponse.json()) as { id: string };
  for (const providerId of ['deepseek', custom.id]) {
    const response = await api('/ai-characters', 'POST', {
      providerId,
      name: 'Managed AI',
      roleDescription: '你是一名建筑师，负责规划房屋。',
      maxTurns: 1,
    });
    assert.equal(response.status, 201);
    const job = (await response.json()) as { id: string };
    await until(
      () => manager!.list().find((j) => j.id === job.id)?.status === 'idle',
    );
    assert.equal(
      room.state.players.size,
      1,
      'completed rounds keep the player online',
    );
    assert.equal(manager.list().find((j) => j.id === job.id)?.task, undefined);
    const firstTask = await api('/tasks', 'POST', {
      characterId: job.id,
      name: 'Say hello once',
      goal: 'Say hello once',
      timing: { kind: 'immediate' },
      timeZone: 'UTC',
      limits: { maxTurns: 1 },
    });
    assert.equal(firstTask.status, 201);
    await until(
      () =>
        manager!.list().find((j) => j.id === job.id)?.task?.status ===
        'completed',
    );
    const idle: AICharacterView = manager.list().find((j) => j.id === job.id)!;
    assert.equal(idle.roleDescription, '你是一名建筑师，负责规划房屋。');
    assert.equal(rolesInRequests.at(-1), idle.roleDescription);
    const taskBeforeUpdate = structuredClone(idle.task);
    const planCount: number = manager.plans.plans.length;
    const runCount: number = manager.plans.runs.length;
    for (const value of [
      { goal: 'Replacement' },
      { startTask: true },
      { taskTimeZone: 'UTC' },
    ]) {
      const rejected = await api(`/ai-characters/${job.id}`, 'PUT', value);
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json()).error, /Tasks/);
    }
    assert.deepEqual(
      manager.list().find((j) => j.id === job.id)?.task,
      taskBeforeUpdate,
    );
    assert.equal(manager.plans.plans.length, planCount);
    assert.equal(manager.plans.runs.length, runCount);
    const original = room.state.players.get(idle.sessionId!)!;
    const originalPosition = { x: original.x, y: original.y, z: original.z };
    assert.equal(
      (
        await api('/tasks', 'POST', {
          characterId: job.id,
          name: 'A different task',
          goal: 'A different task',
          timing: { kind: 'immediate' },
          timeZone: 'UTC',
          limits: { maxTurns: 1 },
        })
      ).status,
      201,
    );
    await until(
      () => manager!.list().find((j) => j.id === job.id)?.status === 'idle',
    );
    const resumed: AICharacterView = manager
      .list()
      .find((j) => j.id === job.id)!;
    assert.equal(resumed.sessionId, idle.sessionId);
    assert.equal(resumed.goal, 'A different task');
    const current = room.state.players.get(resumed.sessionId!)!;
    assert.deepEqual(
      { x: current.x, y: current.y, z: current.z },
      originalPosition,
    );
    assert(
      manager
        .list()
        .find((j) => j.id === job.id)
        ?.logEntries.some((entry) => entry.text.includes('chat')),
    );
    const callsWhenIdle: number = calls;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls, callsWhenIdle, 'idle does not invoke the model');
    const edited = await api(`/ai-characters/${job.id}`, 'PUT', {
      name: 'Renamed AI',
      roleDescription: '你是一名建筑师，先确认位置和尺寸，再规划施工。',
      intervalMode: 'random',
      intervalMinMs: 4000,
      intervalMaxMs: 8000,
      maxTokens: 1024,
    });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).sessionId, idle.sessionId);
    assert.equal(room.state.players.get(idle.sessionId!)!.name, 'Renamed AI');
    assert.deepEqual(
      { x: current.x, y: current.y, z: current.z },
      originalPosition,
    );
    assert.equal(calls, callsWhenIdle);
    speaker = new Session(url.replace('http', 'ws'));
    await speaker.join('Human caller', 'human');
    await speaker.request('chat', {
      text: '@Renamed AI change site',
      scope: 'public',
    });
    await until(
      () =>
        calls === callsWhenIdle + 1 &&
        manager!.list().find((j) => j.id === job.id)?.status === 'idle',
    );
    assert.equal(observations.at(-1)?.attention?.actor, speaker.room.sessionId);
    assert.equal(
      rolesInRequests.at(-1),
      '你是一名建筑师，先确认位置和尺寸，再规划施工。',
    );
    assert.equal(
      manager.list().find((j) => j.id === job.id)?.sessionId,
      idle.sessionId,
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    await speaker.request('chat', {
      text: 'Private instruction',
      scope: 'private',
      recipients: [idle.sessionId],
    });
    await until(
      () =>
        calls === callsWhenIdle + 2 &&
        manager!.list().find((j) => j.id === job.id)?.status === 'idle',
    );
    assert.equal(
      (observations.at(-1)?.attention?.data as { scope: string }).scope,
      'private',
    );
    assert.equal(
      rolesInRequests.at(-1),
      '你是一名建筑师，先确认位置和尺寸，再规划施工。',
    );
    await until(() =>
      speaker!.events.some(
        (e) =>
          e.actor === idle.sessionId &&
          (e.data as { scope?: string }).scope === 'private',
      ),
    );
    await speaker.close();
    speaker = undefined;
    assert.equal(
      (await api(`/ai-characters/${job.id}/stop`, 'POST', {})).status,
      200,
    );
    await until(
      () => manager!.list().find((j) => j.id === job.id)?.status === 'stopped',
    );
    assert.equal(room.state.players.size, 0);
    assert(
      manager.list().some((j) => j.id === job.id),
      'closing retains reusable config',
    );
  }
  const standbyResponse = await api('/ai-characters', 'POST', {
    providerId: 'deepseek',
    name: 'Standby',
    goal: '',
  });
  assert.equal(standbyResponse.status, 201);
  const standby = (await standbyResponse.json()) as AICharacterView;
  await until(
    () => manager!.list().find((j) => j.id === standby.id)?.status === 'idle',
  );
  assert.equal(calls, 8, 'creating a standby character does not call a model');
  assert.equal(
    manager.list().find((j) => j.id === standby.id)?.task,
    undefined,
  );
  assert.equal(
    (
      await api('/tasks', 'POST', {
        characterId: standby.id,
        name: 'Empty task',
        goal: '',
        timing: { kind: 'immediate' },
        timeZone: 'UTC',
      })
    ).status,
    400,
  );
  await api(`/ai-characters/${standby.id}/stop`, 'POST', {});
  await until(
    () =>
      manager!.list().find((j) => j.id === standby.id)?.status === 'stopped',
  );
  assert.equal(
    (await api(`/ai-characters/${standby.id}/join`, 'POST', {})).status,
    200,
  );
  await until(
    () => manager!.list().find((j) => j.id === standby.id)?.status === 'idle',
  );
  assert.equal(calls, 8, 'joining also does not call a model');
  assert.equal(
    (await api(`/ai-characters/${standby.id}/join`, 'POST', {})).status,
    409,
  );
  await api(`/ai-characters/${standby.id}/stop`, 'POST', {});
  await until(
    () =>
      manager!.list().find((j) => j.id === standby.id)?.status === 'stopped',
  );
  assert.equal(calls, 8);
  const created = [] as string[];
  for (let i = 0; i < 4; i++) {
    const res = await api('/ai-characters', 'POST', {
      providerId: 'deepseek',
      name: `Loop ${i}`,
      maxTurns: 1,
      continuous: true,
      intervalMode: 'random',
      intervalMinMs: 60000,
      intervalMaxMs: 60000,
    });
    assert.equal(res.status, 201);
    const roleId = ((await res.json()) as { id: string }).id;
    created.push(roleId);
    await until(
      () => manager!.list().find((j) => j.id === roleId)?.status === 'idle',
    );
    assert.equal(
      (
        await api('/tasks', 'POST', {
          characterId: roleId,
          name: 'Observe',
          goal: 'Observe',
          timing: { kind: 'immediate' },
          timeZone: 'UTC',
          limits: { maxTurns: 1 },
        })
      ).status,
      201,
    );
  }
  await until(() => room.state.players.size === 4);
  await until(() =>
    created.every(
      (id) =>
        manager!.list().find((j) => j.id === id)?.task?.status === 'completed',
    ),
  );
  assert([...room.state.players.values()].every((p) => p.kind === 'ai-agent'));
  speaker = new Session(url.replace('http', 'ws'));
  await speaker.join('Human caller', 'human');
  const sleeping = manager.list().find((j) => j.id === created[0])!;
  const beforeWake = calls;
  assert.equal(
    (await api(`/ai-characters/${created[0]}`, 'PUT', { maxTurns: 9 })).status,
    200,
  );
  await speaker.request('chat', {
    text: 'Wake now',
    scope: 'public',
    recipients: [sleeping.sessionId],
  });
  await until(() => calls === beforeWake + 1, 3000);
  assert.equal(
    observations.at(-1)?.self.id,
    sleeping.sessionId,
    'only the addressed agent skips its 60s interval',
  );
  await speaker.close();
  speaker = undefined;
  assert.equal(
    (
      await api('/ai-characters', 'POST', {
        providerId: 'deepseek',
        name: 'Overflow',
      })
    ).status,
    409,
  );
  assert.equal((await api('/providers/deepseek', 'DELETE')).status, 409);
  assert.equal(
    (await api(`/ai-characters/${created[0]}/stop`, 'POST', {})).status,
    200,
  );
  await until(
    () =>
      manager!.list().find((j) => j.id === created[0])?.status === 'stopped',
  );
  assert.equal(room.state.players.size, 3);
  assert(
    manager
      .list()
      .filter((j) => j.status === 'running')
      .every((j) => j.continuous && j.intervalMode === 'random'),
  );
  assert(
    manager.list().find((j) => j.id === created[0])?.task?.status ===
      'completed',
  );
  // A forbidden tail must prevent even the permitted edit at the head.
  const beforeCapabilities = calls;
  const permissions = { move: true, chat: false, place: true, remove: false };
  const capabilityResponse = await api('/ai-characters', 'POST', {
    providerId: 'deepseek',
    name: 'Capability fixture',
    roleDescription: 'capability fixture',
    skills: ['building', 'guide'],
    permissions,
  });
  assert.equal(capabilityResponse.status, 201);
  const capabilityJob = (await capabilityResponse.json()) as AICharacterView;
  await until(
    () =>
      manager!.list().find((j) => j.id === capabilityJob.id)?.status === 'idle',
  );
  assert.equal(
    calls,
    beforeCapabilities,
    'Skills never start work on their own',
  );
  assert.deepEqual(capabilityJob.permissions, permissions);
  assert.deepEqual(capabilityJob.skills, ['building', 'guide']);
  const revisionBefore = room.state.revision;
  speaker = new Session(url.replace('http', 'ws'));
  await speaker.join('Capability observer', 'human');
  const emitted: unknown[] = [];
  speaker.onEvent = (event) => {
    if (event.type === 'chat') emitted.push(event);
  };
  const capabilityTaskResponse = await api('/tasks', 'POST', {
    characterId: capabilityJob.id,
    name: 'Validate permissions',
    goal: 'Validate permissions',
    timing: { kind: 'immediate' },
    timeZone: 'UTC',
  });
  assert.equal(capabilityTaskResponse.status, 201);
  const capabilityPlan = await capabilityTaskResponse.json();
  await until(
    () =>
      calls > beforeCapabilities &&
      manager!.list().find((j) => j.id === capabilityJob.id)?.status === 'idle',
  );
  assert.equal(
    room.state.revision,
    revisionBefore,
    'No partial edit before rejecting a forbidden chat',
  );
  assert.equal(emitted.length, 0, 'No model chat or automatic receipt');
  assert.deepEqual(
    (capabilitiesInRequests.at(-1) as { permissions: unknown }).permissions,
    permissions,
  );
  assert.deepEqual(
    (capabilitiesInRequests.at(-1) as { skills: unknown }).skills,
    ['building', 'guide'],
  );
  assert(
    manager
      .list()
      .find((j) => j.id === capabilityJob.id)!
      .logEntries.some((entry) => entry.text.includes('聊天权限')),
  );
  // Task schedules use the same permission-checked runtime and origin boundary.
  const capabilityRuns = await (
    await api(`/tasks/${capabilityPlan.id}/runs`)
  ).json();
  assert.equal(
    (await api(`/task-runs/${capabilityRuns.items[0].id}/cancel`, 'POST', {}))
      .status,
    200,
  );
  const schedule = await api(`/tasks`, 'POST', {
    characterId: capabilityJob.id,
    name: 'Scheduled capability check',
    goal: 'Validate permissions',
    timing: { kind: 'interval', everyMs: 60000 },
    timeZone: 'Asia/Shanghai',
    requestId: 'create-schedule',
  });
  assert.equal(schedule.status, 201);
  const plan = await schedule.json();
  const plannedAt = plan.nextRunAt;
  const repeatCreate = await api(`/tasks`, 'POST', {
    characterId: capabilityJob.id,
    name: 'Scheduled capability check',
    goal: 'Validate permissions',
    timing: { kind: 'interval', everyMs: 60000 },
    timeZone: 'Asia/Shanghai',
    requestId: 'create-schedule',
  });
  assert.equal((await repeatCreate.json()).id, plan.id);
  const beforeScheduled = calls;
  assert.equal(
    (
      await api(`/tasks/${plan.id}/run`, 'POST', {
        requestId: 'manual-schedule',
      })
    ).status,
    200,
  );
  await until(
    () =>
      calls > beforeScheduled &&
      manager!.list().find((j) => j.id === capabilityJob.id)?.status === 'idle',
  );
  const history = await (await api(`/tasks/${plan.id}/runs`)).json();
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].task.calls, 1);
  assert.equal(
    room.state.revision,
    revisionBefore,
    'Scheduled work keeps atomic permission checks',
  );
  assert.equal(
    emitted.length,
    0,
    'Scheduled work cannot bypass silent chat policy',
  );
  assert.equal(
    (
      await api(`/tasks/${plan.id}/run`, 'POST', {
        requestId: 'manual-schedule',
      })
    ).status,
    200,
  );
  assert.equal(
    calls,
    beforeScheduled + 1,
    'Retried manual request never calls model twice',
  );
  const summary = (
    await (await api(`/tasks?characterId=${capabilityJob.id}`)).json()
  ).items.find((p: { id: string }) => p.id === plan.id);
  assert.equal(
    summary.nextRunAt,
    plannedAt,
    'Manual execution does not move scheduled trigger',
  );
  assert(!JSON.stringify(history).includes('fixture-secret'));
  assert.equal(
    (await api(`/task-runs/${history.items[0].id}/cancel`, 'POST', {})).status,
    200,
  );
  assert.equal(
    (await api(`/tasks/${plan.id}/archive`, 'POST', {})).status,
    200,
  );
  assert.equal(
    (
      await api(
        `/ai-characters/${capabilityJob.id}`,
        'DELETE',
        undefined,
        'https://untrusted.example',
      )
    ).status,
    403,
  );
  assert.equal(
    (await api(`/ai-characters/${capabilityJob.id}`, 'DELETE')).status,
    204,
  );
  assert(!manager.list().some((j) => j.id === capabilityJob.id));
  assert.equal(
    (await api(`/ai-characters/${capabilityJob.id}`, 'DELETE')).status,
    404,
  );
  await speaker.close();
  speaker = undefined;
  await until(() => room.state.players.size === 3);
  await manager.close();
  await until(() => room.state.players.size === 0);
  assert(!JSON.stringify(manager.list()).includes('fixture-secret'));
  assert(
    manager
      .list()
      .every((j) => !['joining', 'running', 'stopping'].includes(j.status)),
  );
  const beforeRestore = calls;
  manager = new AICharacterManager(store, url.replace('http', 'ws'), {
    session: (url) => new Session(url),
    runner: fixtureRunnerFactory(
      (config, provider) => new ModelPlanner(config, request, provider),
    ),
  });
  await manager.load();
  assert.equal(calls, beforeRestore, 'restoration never spends inference');
  assert.equal(room.state.players.size, 3);
  assert.equal(manager.list().filter((j) => j.status === 'idle').length, 3);
  const stopped = manager.list().find((j) => j.id === created[0])!;
  assert.equal(stopped.status, 'stopped');
  manager.join(stopped.id);
  await manager.settled(stopped.id);
  const priorPlan = manager.tasks.taskPlans(stopped.id)[0];
  await manager.tasks.controlTaskPlan(stopped.id, priorPlan.id, 'run', {
    requestId: 'explicit-rerun',
  });
  await assert.rejects(
    manager.tasks.controlTaskPlan(stopped.id, priorPlan.id, 'run', {
      requestId: 'conflicting-rerun',
    }),
  );
  await until(
    () => manager!.list().find((j) => j.id === stopped.id)?.status === 'idle',
  );
  assert.equal(room.state.players.size, 4);
  assert.throws(
    () => manager!.create({ providerId: 'deepseek', name: 'overflow' }),
    /最多同时在线/,
  );
  await manager.remove(stopped.id);
  await until(() => room.state.players.size === 3);
  for (const j of manager.list().filter((j) => j.sessionId)) manager.stop(j.id);
  await until(() => room.state.players.size === 0);
  console.log(
    'PASS: origin guard, credential redaction, task completion stays online, reuse preserves player identity/position, task replacement, idle spends no inference, close/rejoin, canonical capabilities, atomic permission rejection, silent chat denial, online capacity and restart restoration without inference. Model responses are fixtures.',
  );
} finally {
  globalThis.fetch = originalFetch;
  await speaker?.close();
  await manager?.close();
  await server?.close();
  await rm(dir, { recursive: true, force: true });
}
