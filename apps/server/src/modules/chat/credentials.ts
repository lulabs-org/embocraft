import { randomBytes } from 'node:crypto';
import type { Player } from '@voxel/shared';
import { AppError } from '../../common/errors';

export class ChatCredentials {
  private tokens = new Map<string, string>();

  constructor(private players: () => Iterable<Player>) {}

  issue(id: string) {
    this.revoke(id);
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, id);
    return token;
  }

  revoke(id: string) {
    for (const [token, owner] of this.tokens)
      if (owner === id) this.tokens.delete(token);
  }

  authenticate(token: string) {
    const id = this.tokens.get(token);
    if (!id || ![...this.players()].some((p) => p.id === id && p.connected))
      throw new AppError('游戏连接已失效，请重新进入。', 401);
    return id;
  }

  clear() {
    this.tokens.clear();
  }
}
