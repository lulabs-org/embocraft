import type { Room } from 'colyseus.js';
import { describe, expect, it, vi } from 'vitest';
import { Session } from './colyseus';

describe('agent movement heading', () => {
  it('faces each world-space movement direction and keeps its heading when stopped', () => {
    const send = vi.fn();
    const session = new Session();
    session.room = { send } as unknown as Room;

    for (const [x, z, yaw] of [
      [0, -1, 0],
      [1, 0, -Math.PI / 2],
      [0, 1, -Math.PI],
      [-1, 0, Math.PI / 2],
      [1, -1, -Math.PI / 4],
    ]) {
      session.move(x, z);
      expect(send.mock.lastCall?.[1].payload.yaw).toBeCloseTo(yaw);
    }

    session.move(0, 0);
    expect(send.mock.lastCall?.[1].payload.yaw).toBeCloseTo(-Math.PI / 4);
  });
});
