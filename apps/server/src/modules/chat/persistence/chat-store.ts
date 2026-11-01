import type { PlayerKind, PrismaClient } from '@prisma/client';
import { playerNameKey } from '@voxel/shared';

export type RecordedPlayer = {
  name: string;
  kind: 'human' | 'ai-agent' | 'scripted-agent';
  characterId?: string;
};

export type RecordedChatMessage = {
  senderName: string;
  senderKind?: 'human' | 'ai-agent' | 'scripted-agent';
  scope: 'public' | 'private' | 'nearby';
  kind: 'text' | 'audio';
  text: string;
  audioId?: string;
  durationMs?: number;
  recipients?: string[];
};

function toPlayerKind(kind?: string): PlayerKind {
  if (kind === 'ai-agent') return 'ai_agent';
  if (kind === 'scripted-agent') return 'scripted_agent';
  return 'human';
}

export class ChatStore {
  constructor(private readonly db?: PrismaClient) {}

  async recordPlayer(player: RecordedPlayer): Promise<string | undefined> {
    if (!this.db) return undefined;
    const kind = toPlayerKind(player.kind);
    const normalizedName = playerNameKey(player.name);

    try {
      const row = await this.db.player.upsert({
        where: {
          kind_normalizedName: {
            kind,
            normalizedName,
          },
        },
        create: {
          kind,
          normalizedName,
          displayName: player.name,
          characterId: player.characterId ?? null,
          lastSeenAt: new Date(),
        },
        update: {
          displayName: player.name,
          ...(player.characterId ? { characterId: player.characterId } : {}),
          lastSeenAt: new Date(),
        },
      });
      return row.id;
    } catch (e) {
      console.error('Failed to record player persistence:', e);
      return undefined;
    }
  }

  async recordMessage(msg: RecordedChatMessage): Promise<void> {
    if (!this.db) return;
    const kind = toPlayerKind(msg.senderKind);
    const normalizedName = playerNameKey(msg.senderName);

    try {
      const sender = await this.db.player.findUnique({
        where: {
          kind_normalizedName: {
            kind,
            normalizedName,
          },
        },
      });

      const recipientPlayers =
        msg.recipients && msg.recipients.length > 0
          ? await this.db.player.findMany({
              where: {
                normalizedName: {
                  in: msg.recipients.map((r) => playerNameKey(r)),
                },
              },
            })
          : [];

      await this.db.chatMessage.create({
        data: {
          senderId: sender?.id ?? null,
          senderName: msg.senderName,
          scope: msg.scope,
          kind: msg.kind,
          text: msg.text,
          audioId: msg.audioId ?? null,
          durationMs: msg.durationMs ?? null,
          recipients: {
            create: recipientPlayers.map((p) => ({
              playerId: p.id,
            })),
          },
        },
      });
    } catch (e) {
      console.error('Failed to record chat message:', e);
    }
  }
}
