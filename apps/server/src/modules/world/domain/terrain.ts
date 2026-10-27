import { LIMIT, key, type Block } from '@voxel/shared';
export const height = (x: number, z: number) =>
  Math.abs(x) < 4 && Math.abs(z) < 4
    ? 2
    : 2 + Math.max(0, Math.round(Math.sin(x * 0.32) * Math.cos(z * 0.35) * 2));
export function terrain(): Map<string, Block> {
  const blocks = new Map<string, Block>();
  for (let x = -LIMIT; x <= LIMIT; x++)
    for (let z = -LIMIT; z <= LIMIT; z++)
      for (let y = 0; y <= height(x, z); y++) {
        const b: Block = {
          x,
          y,
          z,
          material: y === height(x, z) ? 'grass' : y === 0 ? 'stone' : 'dirt',
        };
        blocks.set(key(b), b);
      }
  return blocks;
}
