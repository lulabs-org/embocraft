import type { Player } from '@voxel/shared';
import { describe, expect, it } from 'vitest';
import type {
  ActionExecution,
  BatchResult,
  NavigationResult,
  PlannedEdit,
} from '../../contracts/action';
import type { Observation } from '../../contracts/observation';
import { emptyState, type AgentRunState } from '../../contracts/state';
import { newTask } from '../task/state';
import { reconcilePendingEffects, reconcileUnfinishedBuild } from './reconcile';

const SELF: Player = {
  id: 'ai',
  name: 'AI',
  kind: 'ai-agent',
  connected: true,
  x: 0,
  y: 2.5,
  z: 0,
  yaw: 0,
};

function world(
  overrides: Partial<Observation> = {},
  selfX = SELF.x,
): Observation {
  return {
    id: 'world',
    revision: 1,
    radius: 8,
    self: { ...SELF, x: selfX },
    players: [],
    blocks: [],
    events: [],
    allowedActions: [],
    motion: { grounded: true, vy: 0 },
    ...overrides,
  };
}

function state(): AgentRunState {
  return { ...emptyState(), task: { current: newTask('goal') } };
}

function buildPlan(blocks: PlannedEdit[], uncertain?: PlannedEdit[]) {
  return {
    action: { type: 'build' as const, blocks },
    result: {
      ok: false,
      total: blocks.length,
      completed: 0,
      skipped: 0,
      remaining: blocks,
      uncertain,
      failures: [],
      note: 'paused',
    },
  };
}

function batch(...results: ActionExecution[]): BatchResult {
  return {
    actions: results.map((execution) => execution.action),
    results,
    remaining: [],
    ok: false,
    stopReason: 'unknown',
  };
}

const WOOD = {
  x: 1,
  y: 3,
  z: 0,
  material: 'wood',
} as const satisfies PlannedEdit;
const STONE = {
  x: 2,
  y: 3,
  z: 0,
  material: 'stone',
} as const satisfies PlannedEdit;
const REMOVAL = {
  x: 3,
  y: 3,
  z: 0,
  material: null,
} as const satisfies PlannedEdit;
const GOTO = { type: 'goto' as const, x: 4, y: 2.5, z: 0 };

function navigation(status: 'arrived' | 'failed'): NavigationResult {
  return {
    ok: status === 'arrived',
    status,
    note: '',
    position: SELF,
    target: GOTO,
    replans: 0,
  };
}

function edit(
  action: PlannedEdit,
  status: ActionExecution['status'],
): ActionExecution {
  return {
    action: { type: 'edit', ...action },
    status,
    result: { ok: false, id: 'edit', revision: 1 },
  };
}

describe('unfinished build reconciliation', () => {
  it('keeps only blocks the observation does not confirm', () => {
    const memory = state();
    memory.effects.unfinishedBuild = buildPlan([WOOD, STONE], [WOOD, STONE]);
    reconcileUnfinishedBuild(memory, world({ blocks: [WOOD] }));
    expect(memory.effects.unfinishedBuild?.result.remaining).toEqual([STONE]);
    expect(memory.effects.unfinishedBuild?.result.uncertain).toEqual([STONE]);
  });

  it('keeps a block whose observed material differs from the plan', () => {
    const memory = state();
    memory.effects.unfinishedBuild = buildPlan([WOOD]);
    reconcileUnfinishedBuild(
      memory,
      world({ blocks: [{ ...WOOD, material: 'stone' }] }),
    );
    expect(memory.effects.unfinishedBuild?.result.remaining).toEqual([WOOD]);
  });

  it('confirms a planned deletion from a complete empty observation', () => {
    const memory = state();
    memory.effects.unfinishedBuild = buildPlan([REMOVAL]);
    reconcileUnfinishedBuild(memory, world());
    expect(memory.effects.unfinishedBuild).toBeUndefined();
  });

  it('keeps a planned deletion while the block is still visible', () => {
    const memory = state();
    memory.effects.unfinishedBuild = buildPlan([REMOVAL]);
    reconcileUnfinishedBuild(
      memory,
      world({ blocks: [{ ...REMOVAL, material: 'stone' }] }),
    );
    expect(memory.effects.unfinishedBuild?.result.remaining).toEqual([REMOVAL]);
  });
});

describe('pending effect reconciliation', () => {
  it('clears a batch once a failed edit is visible', () => {
    const memory = state();
    memory.effects.pendingEffects = batch(edit(WOOD, 'failed'));
    reconcilePendingEffects(memory, world({ blocks: [WOOD] }));
    expect(memory.effects.pendingEffects).toBeUndefined();
  });

  it('keeps a batch whose edit is not visible yet', () => {
    const memory = state();
    memory.effects.pendingEffects = batch(edit(WOOD, 'failed'));
    reconcilePendingEffects(memory, world());
    expect(memory.effects.pendingEffects).toBeDefined();
  });

  it('clears a batch once a confirmed deletion disappears from the world', () => {
    const memory = state();
    memory.effects.pendingEffects = batch(edit(REMOVAL, 'unknown'));
    reconcilePendingEffects(memory, world());
    expect(memory.effects.pendingEffects).toBeUndefined();
  });

  it('keeps a deletion that is still visible, even inside the observation radius', () => {
    const memory = state();
    memory.effects.pendingEffects = batch(edit(REMOVAL, 'unknown'));
    reconcilePendingEffects(
      memory,
      world({ blocks: [{ ...REMOVAL, material: 'stone' }] }),
    );
    expect(memory.effects.pendingEffects).toBeDefined();
  });

  it('clears a batch once the navigation destination is reached', () => {
    const memory = state();
    memory.effects.pendingEffects = batch({
      action: GOTO,
      status: 'failed',
      result: navigation('failed'),
    });
    reconcilePendingEffects(memory, world({}, GOTO.x));
    expect(memory.effects.pendingEffects).toBeUndefined();
  });

  it('keeps a failed navigation without a verified arrival', () => {
    const memory = state();
    memory.effects.pendingEffects = batch({
      action: GOTO,
      status: 'failed',
      result: navigation('failed'),
    });
    reconcilePendingEffects(memory, world());
    expect(memory.effects.pendingEffects).toBeDefined();
  });

  it('lets a verified replacement arrival supersede a failed goto', () => {
    const memory = state();
    memory.effects.pendingEffects = batch({
      action: GOTO,
      status: 'failed',
      result: navigation('failed'),
    });
    memory.effects.previous = batch({
      action: GOTO,
      status: 'succeeded',
      result: navigation('arrived'),
    });
    reconcilePendingEffects(memory, world({}, GOTO.x));
    expect(memory.effects.pendingEffects).toBeUndefined();
  });

  it('keeps a failed goto when the replacement arrival was not observed', () => {
    const memory = state();
    memory.effects.pendingEffects = batch({
      action: GOTO,
      status: 'failed',
      result: navigation('failed'),
    });
    memory.effects.previous = batch({
      action: GOTO,
      status: 'succeeded',
      result: navigation('arrived'),
    });
    reconcilePendingEffects(memory, world());
    expect(memory.effects.pendingEffects).toBeDefined();
  });

  it('clears a follow that still points at the current task run', () => {
    const memory = state();
    const taskStartedAt = memory.task.current!.startedAt;
    memory.effects.pendingEffects = batch({
      action: { type: 'follow', playerId: 'player', distance: 2 },
      status: 'failed',
    });
    memory.effects.follow = {
      action: { type: 'follow', playerId: 'player', distance: 2 },
      taskStartedAt,
      pursuing: true,
    };
    reconcilePendingEffects(memory, world());
    expect(memory.effects.pendingEffects).toBeUndefined();
  });

  it('keeps a follow without a matching intent', () => {
    const memory = state();
    memory.effects.pendingEffects = batch({
      action: { type: 'follow', playerId: 'player', distance: 2 },
      status: 'failed',
    });
    memory.effects.follow = {
      action: { type: 'follow', playerId: 'player', distance: 2 },
      taskStartedAt: memory.task.current!.startedAt - 1,
      pursuing: true,
    };
    reconcilePendingEffects(memory, world());
    expect(memory.effects.pendingEffects).toBeDefined();
  });

  it('clears a move once the body is displaced', () => {
    const memory = state();
    memory.effects.pendingEffects = batch({
      action: { type: 'move', x: 1, z: 0, jump: false, durationMs: 100 },
      status: 'failed',
      before: SELF,
    });
    reconcilePendingEffects(memory, world({}, 0.1));
    expect(memory.effects.pendingEffects).toBeUndefined();
  });

  it('keeps a move that did not displace the body or has no start position', () => {
    const move: ActionExecution = {
      action: { type: 'move', x: 1, z: 0, jump: false, durationMs: 100 },
      status: 'failed',
      before: SELF,
    };
    const tiny = state();
    tiny.effects.pendingEffects = batch(move);
    reconcilePendingEffects(tiny, world({}, 0.01));
    expect(tiny.effects.pendingEffects).toBeDefined();

    const unknownStart = state();
    unknownStart.effects.pendingEffects = batch({ ...move, before: undefined });
    reconcilePendingEffects(unknownStart, world({}, 0.1));
    expect(unknownStart.effects.pendingEffects).toBeDefined();
  });

  it('clears a build effect when no blueprint is left unfinished', () => {
    const memory = state();
    memory.effects.pendingEffects = batch({
      action: { type: 'build', blocks: [WOOD] },
      status: 'unknown',
    });
    reconcilePendingEffects(memory, world());
    expect(memory.effects.pendingEffects).toBeUndefined();
  });

  it('keeps a build effect while its blueprint is unfinished', () => {
    const memory = state();
    memory.effects.pendingEffects = batch({
      action: { type: 'build', blocks: [WOOD] },
      status: 'unknown',
    });
    memory.effects.unfinishedBuild = buildPlan([WOOD]);
    reconcilePendingEffects(memory, world());
    expect(memory.effects.pendingEffects).toBeDefined();
  });

  it('ignores acknowledged results when deciding whether the batch resolved', () => {
    const memory = state();
    memory.effects.pendingEffects = batch({
      ...edit(WOOD, 'succeeded'),
      result: { ok: true, id: 'edit', revision: 1 },
    });
    reconcilePendingEffects(memory, world());
    expect(memory.effects.pendingEffects).toBeUndefined();
  });

  it('keeps a batch while one unacknowledged result is unresolved', () => {
    const memory = state();
    memory.effects.pendingEffects = batch(edit(WOOD, 'succeeded'), {
      action: { type: 'wait' },
      status: 'failed',
    });
    reconcilePendingEffects(memory, world({ blocks: [WOOD] }));
    expect(memory.effects.pendingEffects).toBeDefined();
  });

  it('forgets an unknown effect once its own batch reconciles', () => {
    const memory = state();
    memory.effects.pendingEffects = batch(edit(WOOD, 'unknown'));
    memory.checkpoint.unknownEffect = {
      id: 'effect-1',
      name: 'edit',
      state: 'unknown',
    };
    memory.checkpoint.pi = {
      version: 3,
      taskStartedAt: 1,
      audience: 'public',
      messages: [],
      inFlight: { id: 'effect-1', name: 'edit', state: 'unknown' },
    };
    reconcilePendingEffects(memory, world({ blocks: [WOOD] }));
    expect(memory.checkpoint.unknownEffect).toBeUndefined();
    expect(memory.checkpoint.pi.inFlight).toBeUndefined();
  });

  it.each([
    ['a chat', 'chat'],
    ['another action', 'goto'],
  ] as const)(
    'keeps an unknown %s effect that the batch does not own',
    (_kind, name) => {
      const memory = state();
      memory.effects.pendingEffects = batch(edit(WOOD, 'unknown'));
      memory.checkpoint.unknownEffect = {
        id: 'effect-1',
        name,
        state: 'unknown',
      };
      memory.checkpoint.pi = {
        version: 3,
        taskStartedAt: 1,
        audience: 'public',
        messages: [],
        inFlight: { id: 'effect-1', name, state: 'unknown' },
      };
      reconcilePendingEffects(memory, world({ blocks: [WOOD] }));
      expect(memory.effects.pendingEffects).toBeUndefined();
      expect(memory.checkpoint.unknownEffect).toBeDefined();
      expect(memory.checkpoint.pi.inFlight).toBeDefined();
    },
  );
});
