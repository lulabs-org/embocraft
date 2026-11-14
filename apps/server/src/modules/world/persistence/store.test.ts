import type { PrismaClient } from '@prisma/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { key, WORLD_ID, type Block, type Edit } from '@voxel/shared';
import { WorldStore } from './store';

const world = { upsert: vi.fn(), updateMany: vi.fn() };
const blockEdit = { upsert: vi.fn() };
const disconnect = vi.fn();
const transaction = vi.fn(async (run: (tx: unknown) => Promise<void>) =>
  run({ world, blockEdit }),
);
const db = {
  world,
  blockEdit,
  $transaction: transaction,
  $disconnect: disconnect,
} as unknown as PrismaClient;
const edit: Edit = { x: 1, y: 2, z: 3, material: 'stone', revision: 7 };

beforeEach(() => {
  vi.clearAllMocks();
  world.updateMany.mockResolvedValue({ count: 1 });
});

it('restores block edits and revision without disconnecting the client', async () => {
  const store = new WorldStore(db);
  const removed = { x: 4, y: 5, z: 6, material: 'stone' } as const;
  const blocks = new Map<string, Block>([[key(removed), removed]]);
  world.upsert.mockResolvedValue({
    revision: 8,
    edits: [edit, { ...removed, material: null }],
  });
  expect(store.mode).toBe('postgresql');
  expect(await store.load(blocks)).toBe(8);
  expect(blocks).toEqual(
    new Map([[key(edit), { x: 1, y: 2, z: 3, material: 'stone' }]]),
  );
  expect(world.upsert).toHaveBeenCalledWith({
    where: { id: WORLD_ID },
    create: { id: WORLD_ID },
    update: {},
    include: { edits: true },
  });
  expect(disconnect).not.toHaveBeenCalled();
});

it('keeps revision CAS and block writes in one transaction', async () => {
  await new WorldStore(db).save(edit);
  expect(transaction).toHaveBeenCalledOnce();
  expect(world.updateMany).toHaveBeenCalledWith({
    where: { id: WORLD_ID, revision: 7 },
    data: { revision: { increment: 1 } },
  });
  expect(blockEdit.upsert).toHaveBeenCalledWith({
    where: { worldId_x_y_z: { worldId: WORLD_ID, x: 1, y: 2, z: 3 } },
    create: { worldId: WORLD_ID, x: 1, y: 2, z: 3, material: 'stone' },
    update: { material: 'stone' },
  });
});

it('rejects a revision conflict before writing block data', async () => {
  world.updateMany.mockResolvedValue({ count: 0 });
  await expect(new WorldStore(db).save(edit)).rejects.toThrow(
    'storage-conflict',
  );
  expect(blockEdit.upsert).not.toHaveBeenCalled();
});
