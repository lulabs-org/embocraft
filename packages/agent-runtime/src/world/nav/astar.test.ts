import { expect, it } from 'vitest';
import { navigationWorld } from '../../../../../tests/support/navigation-world';
import { findPath } from './astar';
import { collisionMap } from './map';

const signal = () => new AbortController().signal;

it('plans a detour around a wall', async () => {
  const w = navigationWorld();
  for (let z = -2; z <= 2; z++) for (let y = 3; y <= 6; y++) w.put(2, y, z);
  const map = collisionMap(w.observe())!;
  const path = await findPath(map, w.body, { x: 4, y: 2.5, z: 0 }, signal());
  expect(path.code).toBeUndefined();
  expect(path.path.some((point) => Math.abs(point.z) === 3)).toBe(true);
});

it('rejects a low ceiling jump and a deep pit', async () => {
  const w = navigationWorld();
  for (let z = -12; z <= 12; z++) {
    w.put(1, 3, z);
    w.put(0, 5, z);
  }
  const path = await findPath(
    collisionMap(w.observe())!,
    w.body,
    { x: 2, y: 2.5, z: 0 },
    signal(),
  );
  expect(path.code).toBe('no_path_in_known_area');

  const hole = navigationWorld();
  for (let z = -12; z <= 12; z++)
    for (let y = 1; y <= 2; y++) hole.blocks.delete(`1,${y},${z}`);
  const pit = await findPath(
    collisionMap(hole.observe())!,
    hole.body,
    { x: 3, y: 2.5, z: 0 },
    signal(),
  );
  expect(pit.code).toBe('no_path_in_known_area');
});
