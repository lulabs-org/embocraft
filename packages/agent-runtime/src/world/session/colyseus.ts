import { Client, type Room } from 'colyseus.js';
import type { Snapshot, Edit, WorldEvent } from '@voxel/shared';
import type { Observation, Result } from '../../contracts';

export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until a condition is met; throws if timeout expires. */
export async function until(predicate: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout)
      throw Error('Timed out waiting for state');
    await delay(25);
  }
}

/**
 * Colyseus client session implementing the AgentSession contract.
 * Bridges agent planning with the voxel room over WebSocket RPC and state streams.
 */
export class Session {
  room!: Room;
  client: Client;
  constructor(
    private serverUrl = process.env.SERVER_URL ?? 'ws://127.0.0.1:2567',
  ) {
    this.client = new Client(serverUrl);
  }
  snapshot?: Snapshot;
  // Bounded ring buffers to prevent memory leaks during long-running agent loops.
  edits: Edit[] = [];
  events: WorldEvent[] = [];
  onEvent?: (event: WorldEvent) => void;
  voice: unknown[] = [];
  chatToken = '';
  spatialSignals: unknown[] = [];
  private id = 0;
  private roomOpen = false;
  private closing?: Promise<void>;
  private pending = new Map<string, (value: unknown) => void>();
  private yaw = 0;

  /** Discover active world room via HTTP, connect over WebSocket, and wait for initial snapshot. */
  async join(name: string, kind = 'scripted-agent') {
    const endpoint = this.serverUrl.replace(/^ws/, 'http');
    const info = (await fetch(`${endpoint}/world`).then((r) => r.json())) as {
      roomId: string;
    };
    this.attach(await this.client.joinById(info.roomId, { name, kind }));
    await until(() => !!this.snapshot);
    return this;
  }

  /** Attach listeners and routing for Colyseus room messages. */
  attach(room: Room) {
    this.room = room;
    this.roomOpen = true;
    this.closing = undefined;
    room.onLeave(() => {
      if (this.room === room) this.roomOpen = false;
    });
    room.onMessage('chat.auth', (v: { token: string }) => {
      this.chatToken = v.token;
    });
    room.onMessage('spatial.signal', (value) => {
      this.spatialSignals.push(value);
      if (this.spatialSignals.length > 100) this.spatialSignals.shift();
    });
    room.onMessage('snapshot', (s: Snapshot) => (this.snapshot = s));
    room.onMessage('edit', (e: Edit) => {
      this.edits.push(e);
      if (this.edits.length > 512) this.edits.shift();
    });
    room.onMessage('event', (e: WorldEvent) => {
      this.events.push(e);
      if (this.events.length > 100) this.events.shift();
      this.onEvent?.(e);
    });
    room.onMessage('voice', (value) => {
      this.voice.push(value);
      if (this.voice.length > 100) this.voice.shift();
    });
    // Resolve matching pending promises on action result or observation response.
    for (const type of ['result', 'observation'])
      room.onMessage(type, (value: { id: string }) => {
        this.pending.get(value.id)?.(value);
        this.pending.delete(value.id);
      });
    room.send('sync');
  }

  /** Send an action request with correlation ID and wait for result with 5s timeout. */
  async request<T = Result>(type: string, payload: unknown = {}): Promise<T> {
    const id = `agent-${++this.id}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`Timeout: ${type}`));
      }, 5000);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value as T);
      });
      this.room.send('action', { id, type, payload });
    });
  }

  /** Fire-and-forget directional movement and jump control. */
  move(x: number, z: number, jump = false) {
    // Inputs use world axes; face the direction of travel and retain that
    // heading when navigation briefly releases the movement input.
    if (Math.hypot(x, z) > 0.001) this.yaw = Math.atan2(-x, -z);
    this.room.send('action', {
      id: `move-${++this.id}`,
      type: 'move',
      payload: { x, z, jump, yaw: this.yaw },
    });
  }

  /** Query field-of-view observation (blocks, players, events, attention) around self. */
  observe() {
    return this.request<Observation>('observe');
  }

  /** Reconnect to the room using Colyseus reconnection token. */
  async reconnect() {
    const token = this.room.reconnectionToken;
    this.room.connection.close();
    await delay(200);
    this.attach(await this.client.reconnect(token));
    await delay(100);
  }

  /** Leave room gracefully with a 1.5s timeout race to prevent hanging on disconnect. */
  async close() {
    if (this.closing) return this.closing;
    if (!this.roomOpen) return;
    const room = this.room;
    this.closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          room.leave(true),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1500);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        room.connection.close();
        this.roomOpen = false;
      }
    })();
    return this.closing;
  }
}
