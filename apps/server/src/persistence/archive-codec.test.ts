import { expect, it } from 'vitest';
import { taskExecutionFixture } from '../../test/helpers/task-execution-fixture';
import { captureTask } from '../modules/tasks';
import type { ManagementArchive } from './archive';
import { decodeArchive, encodeArchive } from './archive-codec';

function fixture(): ManagementArchive {
  const { state } = taskExecutionFixture();
  const memory = state.runtime.snapshot();
  memory.character.usage = { calls: 5, tokens: 1200, estimated: false };
  memory.character.conversation.exchanges = {
    public: [{ text: 'remember this' }],
  };
  state.runtime.restore(memory);
  captureTask(state);
  return {
    version: 3,
    characters: [
      {
        ...state.view,
        createdAt: 100,
        runtime: state.runtime.snapshot(),
        currentRunId: state.currentRunId,
      },
    ],
    plans: state.ledger.plans,
    runs: state.ledger.runs,
    requests: {},
  };
}

it('stores the identical current runtime once and restores detached run history without cumulative usage', () => {
  const original = fixture();
  const before = structuredClone(original);
  const stored = encodeArchive(original);
  expect(stored.version).toBe(4);
  expect(stored.runs[0]).not.toHaveProperty('runtime');
  expect(stored.runs[0].runtimeRef).toEqual({
    version: 1,
    characterId: 'actor',
  });
  expect(original).toEqual(before);

  const restored = decodeArchive(JSON.parse(JSON.stringify(stored)));
  expect(restored).toEqual(JSON.parse(JSON.stringify(original)));
  expect(restored.runs[0]).not.toHaveProperty('runtimeRef');
  expect(restored.runs[0].runtime!.character.usage).toBeUndefined();
  expect(restored.characters[0].runtime!.character.usage?.tokens).toBe(1200);
  restored.runs[0].runtime!.character.conversation.exchanges!.public.push(
    'run only',
  );
  expect(
    restored.characters[0].runtime!.character.conversation.exchanges!.public,
  ).toHaveLength(1);
  expect(
    stored.characters[0].runtime!.character.conversation.exchanges!.public,
  ).toHaveLength(1);
});

it('materializes the old run when switching tasks or deleting its character, preserving historical conversations', () => {
  const archive = decodeArchive(encodeArchive(fixture()));
  const oldRuntime = structuredClone(archive.runs[0].runtime);
  const next = structuredClone(archive.runs[0]);
  next.id = 'next-run';
  next.runtime!.character.conversation.exchanges!.public = [
    { text: 'new conversation' },
  ];
  archive.runs.push(next);
  archive.characters[0].currentRunId = next.id;
  archive.characters[0].runtime = structuredClone(next.runtime);
  archive.characters[0].runtime!.character.usage = {
    calls: 6,
    tokens: 1500,
    estimated: false,
  };

  const switched = encodeArchive(archive);
  expect(switched.runs[0].runtime).toEqual(oldRuntime);
  expect(switched.runs[0].runtimeRef).toBeUndefined();
  expect(switched.runs[1].runtime).toBeUndefined();
  expect(decodeArchive(switched)).toEqual(archive);

  archive.characters = [];
  const detached = encodeArchive(archive);
  expect(detached.runs.every((run) => run.runtime && !run.runtimeRef)).toBe(
    true,
  );
  expect(decodeArchive(detached)).toEqual(archive);
});

it.each(['conversation', 'usage', 'owner', 'currentRun'] as const)(
  'keeps a standalone snapshot when the current run differs in %s',
  (difference) => {
    const archive = fixture();
    const run = archive.runs[0];
    if (difference === 'conversation')
      run.runtime!.character.conversation.exchanges!.public = ['older context'];
    if (difference === 'usage')
      run.runtime!.character.usage = {
        calls: 2,
        tokens: 100,
        estimated: false,
      };
    if (difference === 'owner') run.characterId = 'another-character';
    if (difference === 'currentRun')
      archive.characters[0].currentRunId = 'another-run';
    const stored = encodeArchive(archive);
    expect(stored.runs[0].runtime).toEqual(run.runtime);
    expect(stored.runs[0].runtimeRef).toBeUndefined();
    expect(decodeArchive(stored)).toEqual(archive);
  },
);

it.each([
  'missing',
  'currentRun',
  'owner',
  'conflict',
  'version',
  'null',
] as const)(
  'rejects a corrupt %s runtime reference before recovery',
  (corruption) => {
    const original = fixture();
    const stored = encodeArchive(original);
    if (corruption === 'missing') stored.characters = [];
    if (corruption === 'currentRun')
      stored.characters[0].currentRunId = 'another-run';
    if (corruption === 'owner')
      stored.runs[0].characterId = 'another-character';
    if (corruption === 'conflict')
      stored.runs[0].runtime = original.runs[0].runtime;
    if (corruption === 'version')
      Object.assign(stored.runs[0].runtimeRef!, { version: 99 });
    if (corruption === 'null')
      Object.assign(stored.runs[0], { runtimeRef: null });
    expect(() => decodeArchive(stored)).toThrow('运行时引用无效');
  },
);

it('reads legacy v3 inline snapshots without mutating or discarding either runtime', () => {
  const original = fixture();
  original.runs[0].runtime!.character.conversation.exchanges!.public = [
    'historical context',
  ];
  const restored = decodeArchive(original);
  expect(restored).toEqual(original);
  restored.characters[0].runtime!.execution.health.failures = 3;
  expect(
    original.characters[0].runtime!.execution.health.failures,
  ).toBeUndefined();
});
