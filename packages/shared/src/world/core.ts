/** Canonical id of the built-in world. */
export const WORLD_ID = 'meadow';
/** Horizontal half-extent of the playable volume: valid cells have |x|/|z| <= LIMIT. */
export const LIMIT = 24;
/** Build height limit: valid cells have 0 <= y <= MAX_Y. */
export const MAX_Y = 15;
/** Max block targeting/editing distance, checked server-side against the player's eye position. */
export const REACH = 6;

/** A point in world space; integer values denote a block cell center. */
export type Vec3 = { x: number; y: number; z: number };
/** Placeable block materials; `null` material in an Edit means "remove block". */
export type Material = 'grass' | 'dirt' | 'stone' | 'wood';

/** A solid block: cell position plus its material. */
export type Block = Vec3 & { material: Material };
/**
 * A block add/remove request. `revision` is the client's expected world
 * revision; the server rejects the edit as a conflict if it doesn't match.
 */
export type Edit = Vec3 & { material: Material | null; revision: number };
/** Full world state sent to clients on join, plus persistence metadata. */
export type Snapshot = {
  blocks: Block[];
  revision: number;
  persistence: string;
};

/** A connected entity (human or AI character) rendered in the world. */
export type Player = Vec3 & {
  id: string;
  name: string;
  kind: string;
  yaw: number;
  connected: boolean;
  // Voice pipeline flags, driven by the client and broadcast in presence.
  voiceSending?: boolean;
  voiceListening?: boolean;
  voiceReplies?: boolean;
};

export function normalizePlayerName(value: unknown): string {
  const name = typeof value === 'string' ? value.normalize('NFC').trim() : '';
  return name.slice(0, 24).trim() || 'Explorer';
}

export function playerNameKey(value: unknown): string {
  return normalizePlayerName(value).toLowerCase();
}
/** Per-frame movement input from the player: local x/z axes, jump, and camera yaw. */
export type Input = { x: number; z: number; jump: boolean; yaw: number };

/** Room-level presence info: who is online plus the world's current revision. */
export type WorldPresence = {
  worldId: string;
  roomId: string;
  revision: number;
  capacity: number;
  persistence: string;
  updatedAt: number;
  players: Player[];
};
/** An append-only world event (edits, joins, etc.) streamed to clients and logs. */
export type WorldEvent = {
  actorKind?: string;
  seq: number;
  type: string;
  actor: string;
  at: number;
  data: unknown;
};
