import { describe, expect, it } from 'vitest';
import { ChatStore } from './chat-store';
import type { PrismaClient } from '@prisma/client';

describe('ChatStore', () => {
  it('records player and chat messages with recipients in db', async () => {
    let savedPlayer: { create: { normalizedName: string } } | undefined;
    let savedMessage: { data: Record<string, unknown> } | undefined;

    const mockDb = {
      player: {
        upsert: async (args: { create: { normalizedName: string } }) => {
          savedPlayer = args;
          return { id: 'player-uuid-1', ...args.create };
        },
        findUnique: async () => ({
          id: 'player-uuid-1',
          displayName: 'Alice',
        }),
        findMany: async () => [
          { id: 'player-uuid-2', displayName: 'Bob', normalizedName: 'bob' },
        ],
      },
      chatMessage: {
        create: async (args: { data: Record<string, unknown> }) => {
          savedMessage = args;
          return { id: 'msg-uuid-1', ...args.data };
        },
      },
    } as unknown as PrismaClient;

    const store = new ChatStore(mockDb);

    const playerId = await store.recordPlayer({
      name: 'Alice',
      kind: 'human',
    });
    expect(playerId).toBe('player-uuid-1');
    expect(savedPlayer?.create.normalizedName).toBe('alice');

    await store.recordMessage({
      senderName: 'Alice',
      senderKind: 'human',
      scope: 'private',
      kind: 'text',
      text: 'Hello Bob',
      recipients: ['Bob'],
    });

    expect(savedMessage).toMatchObject({
      data: {
        senderId: 'player-uuid-1',
        senderName: 'Alice',
        scope: 'private',
        kind: 'text',
        text: 'Hello Bob',
        recipients: {
          create: [{ playerId: 'player-uuid-2' }],
        },
      },
    });
  });

  it('handles gracefully when db is not provided', async () => {
    const store = new ChatStore(undefined);
    expect(
      await store.recordPlayer({ name: 'Alice', kind: 'human' }),
    ).toBeUndefined();
    await expect(
      store.recordMessage({
        senderName: 'Alice',
        scope: 'public',
        kind: 'text',
        text: 'Hello',
      }),
    ).resolves.not.toThrow();
  });
});
