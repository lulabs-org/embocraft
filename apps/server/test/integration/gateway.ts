import {
  ManagementEvents,
  type PublicAICharacterView,
  type PublicPlanView,
  type PublicRunView,
  type ManagementEvent,
  type CommandReceipt,
} from '@voxel/shared/management';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createTestServer } from '../helpers/test-server';
import { HttpManagementProbe } from '../helpers/management-probe';
import { Session, until } from '@voxel/agent-runtime';
const token = 'fixture-gateway-token-for-tests',
  origin = 'http://127.0.0.1:5188';
const server = await createTestServer({
  origin,
  agentDependencies: {
    session: (url) => new Session(url),
    runner: () => ({
      async run(o) {
        if (o.memory.task.current) {
          o.memory.task.current.status = 'waiting';
          o.memory.task.current.reason = 'fixture';
        }
        await o.checkpoint?.();
      },
    }),
  },
});
const clients: HttpManagementProbe[] = [];
const connect = (secret = token) => {
  const c = new HttpManagementProbe(
    server.httpUrl,
    secret,
    new ManagementEvents({
      url: server.url + '/ai-characters/gateway',
      token: () => secret,
      socket: (url) => new WebSocket(url, { origin }),
      reconnect: false,
    }),
  );
  clients.push(c);
  return c;
};
const http = (path: string, method = 'GET', body?: unknown, key?: string) =>
  fetch(server.httpUrl + path, {
    method,
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
const cli = (...args: string[]) =>
  new Promise<{ id: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(
          new URL(
            '../../../../scripts/agent/agent-control.ts',
            import.meta.url,
          ),
        ),
        ...args,
        '--url',
        server.url + '/ai-characters/gateway',
        '--json',
      ],
      {
        env: { ...process.env, AGENT_GATEWAY_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '',
      err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(Error(err));
      else {
        try {
          resolve(JSON.parse(out));
        } catch (e) {
          reject(e);
        }
      }
    });
  });
try {
  assert.equal(
    (
      await fetch(server.httpUrl + '/ai-characters', {
        headers: { Origin: origin },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(server.httpUrl + '/ai-characters', {
        headers: { Origin: 'https://wrong', Authorization: `Bearer ${token}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(server.httpUrl + '/ai-characters', {
        headers: { Authorization: token },
      })
    ).status,
    401,
  );
  assert.equal(
    (await fetch(server.httpUrl + '/voice/asr/services')).status,
    401,
  );
  assert.equal(
    (
      await fetch(server.httpUrl + '/voice/asr/services', {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    200,
  );
  const bad = connect('wrong');
  await assert.rejects(bad.connect());
  bad.close();
  const c = connect(),
    other = connect();
  const events: ManagementEvent[] = [];
  other.onEvent((e) => events.push(e));
  await Promise.all([c.connect(), other.connect()]);
  await other.subscribe({ scope: 'all' });
  await until(() => events.length > 0);
  const value = {
    providerId: 'deepseek',
    name: 'Gateway fixture',
    goal: '',
  };
  const first = await c.request<PublicAICharacterView>(
    'characters.create',
    { value },
    { commandId: 'create-stable' },
  );
  const duplicateAgent = await c.request<PublicAICharacterView>(
    'characters.create',
    { value },
    { commandId: 'create-stable' },
  );
  assert.equal(duplicateAgent.id, first.id);
  assert.equal((await http('/ai-characters')).status, 200);
  assert.equal(
    (await c.request<PublicAICharacterView[]>('characters.list')).length,
    1,
  );
  await assert.rejects(
    c.request(
      'characters.create',
      { value: { ...value, name: 'different' } },
      { commandId: 'create-stable' },
    ),
  );
  await until(() => server.characters.list()[0].status === 'idle');
  const standby = await c.request<PublicAICharacterView>('characters.get', {
    characterId: first.id,
  });
  assert.equal(standby.taskIdentity, null);
  assert.equal(standby.task, undefined);
  assert.equal((await c.request<{ total: number }>('plans.list')).total, 0);
  for (const [i, value] of [
    { startTask: true },
    { startTask: false },
    { taskTimeZone: 'UTC' },
    { goal: 'Hidden task' },
  ].entries()) {
    await assert.rejects(
      c.request(
        'characters.create',
        { value: { providerId: 'deepseek', name: 'Rejected', ...value } },
        { commandId: `invalid-create-${i}` },
      ),
      /Tasks/,
    );
    await assert.rejects(
      c.request(
        'characters.update',
        { characterId: first.id, value },
        { commandId: `invalid-update-${i}` },
      ),
      /Tasks/,
    );
  }
  assert.equal(
    (await c.request<PublicAICharacterView[]>('characters.list')).length,
    1,
  );
  assert.equal((await c.request<{ total: number }>('plans.list')).total, 0);
  const immediate = {
    name: 'Immediate fixture',
    goal: '等待',
    timing: { kind: 'immediate' },
    timeZone: 'UTC',
  };
  const plan = await c.request<PublicPlanView>(
    'plans.create',
    { characterId: first.id, value: immediate },
    { commandId: 'assign' },
  );
  await until(() => server.characters.list()[0].task?.status === 'waiting');
  const duplicatePlanCreate = await c.request<PublicPlanView>(
    'plans.create',
    { characterId: first.id, value: immediate },
    { commandId: 'assign' },
  );
  assert.equal(duplicatePlanCreate.id, plan.id);
  const history = await c.request<{
    total: number;
    resourceVersion: number;
    items: PublicRunView[];
    active: PublicRunView[];
  }>('runs.list', { planId: plan.id });
  assert.equal(history.total, 1, 'immediate creation starts exactly one run');
  assert.equal(typeof history.resourceVersion, 'number');
  for (const run of [...history.items, ...history.active]) {
    assert.equal(run.resourceVersion, history.resourceVersion);
    assert.ok(Object.hasOwn(run, 'taskIdentity'));
  }
  const runId = history.items[0].id;
  await server.characters.settled(first.id);
  const beforeUpdate = await c.request<PublicAICharacterView>(
    'characters.get',
    {
      characterId: first.id,
    },
  );
  await assert.rejects(
    c.request(
      'characters.update',
      {
        characterId: first.id,
        value: { goal: 'Replacement', name: 'Must not rename' },
      },
      { commandId: 'reject-replacement' },
    ),
    /Tasks/,
  );
  const afterUpdate = await c.request<PublicAICharacterView>('characters.get', {
    characterId: first.id,
  });
  assert.deepEqual(afterUpdate.task, beforeUpdate.task);
  assert.equal(afterUpdate.name, beforeUpdate.name);
  assert.equal(
    (
      await c.request<{
        total: number;
        resourceVersion: number;
        items: PublicRunView[];
        active: PublicRunView[];
      }>('runs.list', { planId: plan.id })
    ).total,
    1,
  );
  for (const operation of ['task', 'pause', 'resume', 'cancel']) {
    assert.equal(
      (
        await http(`/ai-characters/${first.id}/${operation}`, 'POST', {
          goal: 'wrong',
        })
      ).status,
      404,
    );
  }
  for (const method of [
    'tasks.assign',
    'tasks.pause',
    'tasks.resume',
    'tasks.cancel',
  ]) {
    await assert.rejects(
      c.request(
        method,
        { characterId: first.id },
        { commandId: `removed-${method.replace('.', '-')}` },
      ),
    );
  }
  assert.equal(server.characters.list()[0].task?.status, 'waiting');

  await assert.rejects(
    c.request(
      'runs.control',
      {
        runId,
        operation: 'cancel',
        characterId: first.id,
        expectedTask: { id: 'old', revision: 0, startedAt: 0 },
      },
      { commandId: 'stale' },
    ),
  );
  assert.equal(
    (await c.request<CommandReceipt>('commands.get', { commandId: 'stale' }))
      .state,
    'rejected',
  );
  const task = await c.request<PublicAICharacterView>('characters.get', {
    characterId: first.id,
  });
  const paused = await c.request<PublicRunView>(
    'runs.control',
    { runId, operation: 'pause', expectedTask: task.taskIdentity },
    { commandId: 'pause' },
  );
  assert.equal(paused.id, runId);
  assert.equal(paused.planId, plan.id);
  assert.equal(paused.status, 'paused');
  assert.equal(server.characters.list()[0].task?.status, 'paused');
  const concurrentPlan = await c.request<PublicPlanView>(
    'plans.create',
    {
      characterId: first.id,
      value: { ...immediate, name: 'Second execution' },
    },
    { commandId: 'second-execution' },
  );
  assert.equal(server.characters.list()[0].task?.status, 'paused');
  const queuedHistory = await c.request<{
    total: number;
    resourceVersion: number;
    items: PublicRunView[];
    active: PublicRunView[];
  }>('runs.list', {
    planId: concurrentPlan.id,
  });
  assert.equal(queuedHistory.items[0].status, 'queued');
  assert.equal(queuedHistory.items[0].task, undefined);
  await assert.rejects(
    c.request(
      'runs.control',
      {
        runId: queuedHistory.items[0].id,
        operation: 'resume',
        expectedTask: task.taskIdentity,
      },
      { commandId: 'reject-early-start' },
    ),
  );
  await c.request(
    'runs.control',
    {
      runId: queuedHistory.items[0].id,
      operation: 'cancel',
      expectedTask: task.taskIdentity,
    },
    { commandId: 'cancel-queued' },
  );
  assert.equal(server.characters.list()[0].task?.status, 'paused');
  const updated = await c.request<PublicAICharacterView>('characters.get', {
    characterId: first.id,
  });
  await c.request(
    'runs.control',
    { runId, operation: 'resume', expectedTask: updated.taskIdentity },
    { commandId: 'resume' },
  );
  await until(() => server.characters.list()[0].task?.status === 'waiting');
  c.close();
  assert.equal(server.characters.list()[0].task?.status, 'waiting');
  assert(server.characters.list()[0].sessionId);
  const read = await http('/ai-characters');
  assert.equal(read.status, 200);
  assert.equal((await read.json())[0].id, first.id);
  await until(() => events.some((e) => e.event === 'changed'));
  assert(events.every((e, i) => e.seq === i + 1));
  assert(!JSON.stringify(events).includes(token));
  assert(!JSON.stringify(events).includes('fixture-only'));
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(
          new URL(
            '../../../../scripts/agent/agent-control.ts',
            import.meta.url,
          ),
        ),
        'status',
        first.id,
        '--url',
        server.url + '/ai-characters/gateway',
        '--json',
      ],
      {
        env: { ...process.env, AGENT_GATEWAY_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '',
      err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(out) : reject(Error(err)),
    );
  });
  assert.equal(JSON.parse(output).id, first.id);
  assert(
    server.characters.list()[0].sessionId,
    'CLI exit must not stop hosted agent',
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(
          new URL(
            '../../../../scripts/agent/agent-control.ts',
            import.meta.url,
          ),
        ),
        'watch',
        first.id,
        '--url',
        server.url + '/ai-characters/gateway',
        '--json',
      ],
      {
        env: { ...process.env, AGENT_GATEWAY_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let ready = false,
      error = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(Error('CLI watch did not exit'));
    }, 10000);
    child.stdout.on('data', (data) => {
      if (!ready && String(data).includes('snapshot')) {
        ready = true;
        child.kill('SIGINT');
      }
    });
    child.stderr.on('data', (data) => (error += data));
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (ready && code === 0) resolve();
      else reject(Error(error || `watch exited ${code}`));
    });
  });
  assert(
    server.characters.list()[0].sessionId,
    'watch Ctrl+C must not stop the hosted Agent',
  );
  const latest = await other.request<PublicAICharacterView>('characters.get', {
    characterId: first.id,
  });
  await other.request(
    'runs.control',
    { runId, operation: 'cancel', expectedTask: latest.taskIdentity },
    { commandId: 'cancel' },
  );
  assert.equal(server.characters.list()[0].task?.status, 'cancelled');
  const cliPlan = await cli(
    'task',
    'create',
    first.id,
    '--goal',
    'CLI immediate task',
  );
  await until(() => server.characters.list()[0].task?.status === 'waiting');
  const cliRuns = await other.request<{
    total: number;
    resourceVersion: number;
    items: PublicRunView[];
    active: PublicRunView[];
  }>('runs.list', { planId: cliPlan.id });
  assert.equal(cliRuns.total, 1);
  const cliRunId = cliRuns.items[0].id;
  await cli('run', 'pause', cliRunId, '--character', first.id);
  assert.equal(server.characters.list()[0].task?.status, 'paused');
  await other.request('characters.stop', { characterId: first.id });
  await assert.rejects(
    cli('run', 'resume', cliRunId, '--character', first.id),
    /离线/,
  );
  assert.equal(
    server.characters.list()[0].status,
    'stopped',
    'resume cannot implicitly join the world',
  );
  await other.request('characters.join', { characterId: first.id });
  await until(() => server.characters.list()[0].status === 'idle');
  assert.equal(
    server.characters.list()[0].task?.status,
    'paused',
    'join must not resume task execution',
  );
  await cli('run', 'resume', cliRunId, '--character', first.id);
  await until(() => server.characters.list()[0].task?.status === 'waiting');
  await cli('run', 'cancel', cliRunId, '--character', first.id);
  assert.equal(server.characters.list()[0].task?.status, 'cancelled');
  assert.equal(
    (
      await other.request<{
        total: number;
        resourceVersion: number;
        items: PublicRunView[];
        active: PublicRunView[];
      }>('runs.list', { planId: cliPlan.id })
    ).total,
    1,
    'resume continues the same run',
  );
  const second = await other.request<PublicAICharacterView>(
    'characters.create',
    { value: { ...value, name: 'Second', joinWorld: false } },
    { commandId: 'second' },
  );
  const draft = {
    name: 'Global plan',
    goal: '观察世界',
    timing: { kind: 'interval', everyMs: 3600000 },
    timeZone: 'UTC',
    limits: { maxSteps: 20, maxTokens: 20000, maxRuntimeMs: 600000 },
    totalTokenBudget: 100000,
  };
  const planned = await other.request<PublicPlanView>(
    'plans.create',
    { characterId: first.id, value: draft },
    { commandId: 'global-plan' },
  );
  const duplicatePlan = await http(
    `/tasks`,
    'POST',
    { ...draft, characterId: first.id, requestId: 'global-plan' },
    'global-plan-retry',
  );
  assert.equal(duplicatePlan.status, 201);
  assert.equal((await duplicatePlan.json()).id, planned.id);
  assert.equal(
    (
      await other.request<{ total: number }>('plans.list', {
        search: 'Global plan',
      })
    ).total,
    1,
  );
  const unsubscribePlans = await other.subscribe({ scope: 'plans' });
  const assigned = await other.request<PublicPlanView>(
    'plans.reassign',
    {
      planId: planned.id,
      targetCharacterId: second.id,
      expectedPlanRevision: planned.revision,
    },
    { commandId: 'reassign-plan' },
  );
  assert.equal(assigned.characterId, second.id);
  assert.equal(assigned.state, 'paused');
  await assert.rejects(
    other.request(
      'plans.control',
      {
        planId: planned.id,
        operation: 'resume',
        expectedPlanRevision: planned.revision,
      },
      { commandId: 'stale-plan' },
    ),
  );
  assert.equal(
    (
      await http(`/tasks/${planned.id}/pause`, 'POST', {
        characterId: first.id,
      })
    ).status,
    409,
  );
  await other.request(
    'characters.delete',
    { characterId: second.id },
    { commandId: 'delete-second' },
  );
  const retained = await other.request<PublicPlanView>('plans.get', {
    planId: planned.id,
  });
  assert.equal(retained.characterId, undefined);
  assert.equal(retained.state, 'paused');
  assert.equal(retained.characterName, 'Second');
  assert.equal(
    (
      await other.request<{ total: number }>('plans.list', {
        state: 'unassigned',
      })
    ).total,
    1,
  );
  assert.equal(
    (
      await other.request<{
        total: number;
        resourceVersion: number;
        items: PublicRunView[];
        active: PublicRunView[];
      }>('runs.list', { planId: planned.id })
    ).total,
    0,
  );
  await until(() =>
    events.some((e) => e.event === 'changed' && e.data?.resource === 'plans'),
  );
  unsubscribePlans();
  console.log(
    'PASS Management: authenticated HTTP commands and notifications, command deduplication and persistent plan request IDs, revision conflicts, global plans/reassignment/deletion, subscriptions, task controls, disconnect survival, CLI state and exit.',
  );
} finally {
  for (const c of clients) c.close();
  await server.close();
}
