import { WORLD_ID } from '@voxel/shared';
import { expect, test } from 'vitest';
test('built-in world identity', () => {
  expect(WORLD_ID).toBe('meadow');
});
