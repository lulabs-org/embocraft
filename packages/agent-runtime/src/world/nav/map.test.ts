import { expect, it } from 'vitest';
import { navigationWorld } from '../../../../../tests/support/navigation-world';
import { collisionMap } from './map';

it('rejects unknown or unsupported space and requires navigation data', () => {
  const w = navigationWorld();
  const map = collisionMap(w.observe())!;
  expect(map.clear({ x: 9, y: 3, z: 0 })).toBe(false);
  expect(map.stand({ x: 0, y: 5.501, z: 0 })).toBe(false);

  const missing = w.observe();
  delete missing.navigation;
  expect(collisionMap(missing)).toBeUndefined();
});
