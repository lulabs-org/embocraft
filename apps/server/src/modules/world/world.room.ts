import { env } from '../../core/config/env';
import { RealtimeHub, type BailianConfig } from '../realtime';
import { WorldChat, visibleEvent } from '../chat';
import {
  AgentSpeech,
  PiperTts,
  createSpatialSignaling,
  type VoiceServiceStore,
} from '../audio';
import { WorldStore } from './persistence/store';
import { Room, Client, ServerError } from '@colyseus/core';
import { Avatar, WorldState } from './world.schema';
import {
  LIMIT,
  MAX_Y,
  key,
  simulate,
  distance,
  WORLD_ID,
  type ChatData,
  type WorldPresence,
  type Input,
  type Edit,
  type WorldEvent,
} from '@voxel/shared';
import { terrain } from './domain/terrain';
import {
  normalizePlayerName,
  playerNameKey,
  PLAYER_NAME_TAKEN,
} from './domain/player-name';
import { validateEdit, parseInput } from './domain/validation';
const zero: Input = { x: 0, z: 0, jump: false, yaw: 0 };
let activeRoom = false;
export class WorldRoom extends Room<WorldState> {
  private voiceServices?: VoiceServiceStore;
  private releaseVoiceServices?: () => void;
  agentSpeech = new AgentSpeech(
    () => this.state.players.values(),
    (recipient, event) =>
      this.clients
        .find((c) => c.sessionId === recipient)
        ?.send('agent.speech', event),
    (actor, message) =>
      this.clients
        .find((c) => c.sessionId === actor)
        ?.send('agent.speech.error', { message }),
    (actor) => this.voiceServices?.forActor(actor) ?? new PiperTts(),
  );
  chat = new WorldChat(
    () => this.state.players.values(),
    (actor, data) => this.chatEvent(actor, data),
  );
  blocks = terrain();
  store!: WorldStore;
  private bodies = new Map<
    string,
    { vy: number; grounded: boolean; input: Input; lastInput: number }
  >();
  private budget = new Map<string, { at: number; count: number }>();
  private signalBudget = new Map<string, { at: number; count: number }>();
  private events: WorldEvent[] = [];
  private seq = 0;
  private ownsActive = false;
  private realtimeConfig: () => BailianConfig = () => env.readRealtime();
  private spatialSignal = createSpatialSignaling(
    (id) => this.state.players.get(id),
    (recipient, signal) =>
      this.clients
        .find((c) => c.sessionId === recipient)
        ?.send('spatial.signal', signal),
  );
  private realtime = new RealtimeHub(
    (owner) => ({
      revision: () => this.state.revision,
      observe: () => {
        const player = this.state.players.get(owner);
        if (!player?.connected) throw Error('disconnected');
        return {
          revision: this.state.revision,
          self: { x: player.x, y: player.y, z: player.z, yaw: player.yaw },
          blocks: [...this.blocks.values()]
            .filter((b) => distance(b, player) <= 6)
            .sort((a, b) => distance(a, player) - distance(b, player))
            .slice(0, 64),
        };
      },
    }),
    (owner, event) =>
      this.clients.find((c) => c.sessionId === owner)?.send('realtime', event),
    () => this.realtimeConfig(),
  );
  private queue: Promise<void> = Promise.resolve();
  autoDispose = false;
  maxClients = 16;
  async onCreate(
    options: {
      voiceServices?: VoiceServiceStore;
      store?: WorldStore;
      realtimeConfig?: () => BailianConfig;
    } = {},
  ) {
    this.voiceServices = options.voiceServices;
    this.releaseVoiceServices = this.voiceServices?.onChange((actor) =>
      this.agentSpeech.cancel(actor),
    );
    if (activeRoom)
      throw new Error('Single world is full; join the existing room');
    activeRoom = true;
    this.ownsActive = true;
    this.store = options.store ?? new WorldStore();
    if (options.realtimeConfig) this.realtimeConfig = options.realtimeConfig;
    this.setState(new WorldState());
    try {
      this.state.revision = await this.store.load(this.blocks);
    } catch (error) {
      activeRoom = false;
      throw error;
    }
    this.setPatchRate(50);
    this.onMessage('sync', (client) => {
      if (this.allow(client)) this.snapshot(client);
    });
    this.onMessage('action', (client, value) => {
      if (!this.allow(client, value?.type === 'spatial.signal')) return;
      if (
        !value ||
        typeof value !== 'object' ||
        typeof value.id !== 'string' ||
        value.id.length > 80
      )
        return this.reply(client, '', false, 'invalid-envelope');
      const { id } = value;
      let { type, payload } = value;
      if (typeof type === 'string' && type.startsWith('realtime.')) {
        try {
          if (this.state.players.get(client.sessionId)?.kind !== 'human')
            throw Error('human-session-required');
          if (type === 'realtime.approve') {
            payload = this.realtime.approve(client.sessionId, payload);
            type = 'edit'; // Reuse the authoritative serialized edit validation and persistence below.
          } else {
            this.realtime.handle(client.sessionId, type, payload);
            return this.reply(client, id, true);
          }
        } catch (error) {
          return this.reply(
            client,
            id,
            false,
            error instanceof Error ? error.message : 'realtime-failed',
          );
        }
      }
      if (type === 'agent.voice') {
        const player = this.state.players.get(client.sessionId);
        if (
          !player ||
          !['ai-agent', 'scripted-agent'].includes(player.kind) ||
          typeof payload?.enabled !== 'boolean'
        )
          return this.reply(client, id, false, 'invalid-agent-voice');
        player.voiceReplies = payload.enabled;
        if (!payload.enabled) this.agentSpeech.cancel(player.id);
        return this.reply(client, id, true);
      }
      if (type === 'rename') {
        const player = this.state.players.get(client.sessionId);
        if (
          !player ||
          typeof payload?.name !== 'string' ||
          !payload.name.trim() ||
          payload.name.trim().length > 24
        )
          return this.reply(client, id, false, 'invalid-name');
        player.name = payload.name.trim();
        return this.reply(client, id, true);
      }
      if (type === 'move') {
        const input = parseInput(payload),
          body = this.bodies.get(client.sessionId);
        if (!input || !body)
          return this.reply(client, id, false, 'invalid-input');
        body.input = input;
        body.lastInput = Date.now();
        return;
      }
      if (type === 'observe') {
        this.observe(client, id);
        return;
      }
      if (type === 'chat') {
        try {
          this.chat.send(client.sessionId, payload);
          return this.reply(client, id, true);
        } catch (error) {
          return this.reply(
            client,
            id,
            false,
            error instanceof Error ? error.message : 'invalid-chat',
          );
        }
      }
      if (type === 'spatial.state') {
        const player = this.state.players.get(client.sessionId);
        if (
          !player ||
          player.kind !== 'human' ||
          typeof payload?.sending !== 'boolean' ||
          typeof payload?.listening !== 'boolean'
        )
          return this.reply(client, id, false, 'invalid-spatial-state');
        if (!payload.sending) this.chat.cancelSpatial(client.sessionId);
        player.voiceSending = payload.sending;
        player.voiceListening = payload.listening;
        return this.reply(client, id, true);
      }
      if (type === 'spatial.signal') {
        this.spatialSignal(client.sessionId, payload);
        return;
      }
      if (type === 'edit') {
        this.queue = this.queue
          .then(async () => {
            if (!this.state.players.get(client.sessionId)?.connected)
              return this.reply(client, id, false, 'disconnected');
            if (!payload || typeof payload !== 'object')
              return this.reply(client, id, false, 'invalid-edit');
            const error = validateEdit(
              payload as Edit,
              this.state.players.get(client.sessionId)!,
              [...this.state.players.values()],
              this.blocks,
              this.state.revision,
            );
            if (error) {
              this.reply(client, id, false, error);
              if (error === 'conflict') this.snapshot(client);
              return;
            }
            const edit = payload as Edit;
            await this.store.save(edit);
            if (edit.material === null) this.blocks.delete(key(edit));
            else
              this.blocks.set(key(edit), {
                x: edit.x,
                y: edit.y,
                z: edit.z,
                material: edit.material,
              });
            this.state.revision++;
            this.broadcast('edit', { ...edit, revision: this.state.revision });
            this.event('block-edited', client.sessionId, edit);
            this.reply(client, id, true);
          })
          .catch((error) => {
            console.error('edit failed', error);
            this.reply(client, id, false, 'storage-unavailable');
          });
        return;
      }
      this.reply(client, id, false, 'unknown-action');
    });
    this.setSimulationInterval((delta) => {
      const dt = Math.min(delta / 1000, 0.05);
      for (const [id, body] of this.bodies) {
        const p = this.state.players.get(id);
        if (!p?.connected) continue;
        const input =
          Date.now() - body.lastInput < 250
            ? body.input
            : { ...zero, yaw: p.yaw };
        const b = {
          x: p.x,
          y: p.y,
          z: p.z,
          vy: body.vy,
          grounded: body.grounded,
        };
        simulate(b, input, this.blocks, dt);
        p.x = b.x;
        p.y = b.y;
        p.z = b.z;
        p.yaw = input.yaw;
        body.vy = b.vy;
        body.grounded = b.grounded;
      }
    }, 50);
  }
  onJoin(client: Client, options: { name?: string; kind?: string }) {
    const name = normalizePlayerName(options.name);
    // Check and claim synchronously, including avatars held for reconnection.
    if (
      [...this.state.players.values()].some(
        (p) => playerNameKey(p.name) === playerNameKey(name),
      )
    ) {
      throw new ServerError(PLAYER_NAME_TAKEN, 'Player name already taken');
    }
    const p = new Avatar();
    p.id = client.sessionId;
    p.name = name;
    p.kind =
      options.kind === 'ai-agent'
        ? 'ai-agent'
        : options.kind === 'scripted-agent'
          ? 'scripted-agent'
          : 'human';
    const slot = this.state.players.size;
    p.x = (slot % 3) - 1;
    p.z = (Math.floor(slot / 3) % 3) - 1;
    // Spawn above the highest edited cell to avoid trapping new players.
    p.y =
      Math.max(
        2,
        ...[...this.blocks.values()]
          .filter((b) => b.x === Math.round(p.x) && b.z === Math.round(p.z))
          .map((b) => b.y),
      ) + 0.55;
    this.state.players.set(p.id, p);
    this.bodies.set(p.id, {
      vy: 0,
      grounded: false,
      input: { ...zero },
      lastInput: 0,
    });
    this.snapshot(client);
    client.send('chat.auth', { token: this.chat.issue(p.id) });
    this.event('joined', p.id, { name: p.name, kind: p.kind });
  }
  async onLeave(client: Client, consented: boolean) {
    // Colyseus also calls onLeave when onJoin rejects before creating an avatar.
    if (!this.state.players.has(client.sessionId)) return;
    this.realtime.close(client.sessionId);
    this.agentSpeech.cancel(client.sessionId);
    const p = this.state.players.get(client.sessionId);
    this.chat.revoke(client.sessionId);
    if (p) {
      p.connected = false;
      p.voiceSending = false;
      p.voiceListening = false;
    }
    const body = this.bodies.get(client.sessionId);
    if (body) body.input = { ...zero };
    if (!consented) {
      try {
        const reconnected = await this.allowReconnection(client, 20);
        if (p) p.connected = true;
        this.snapshot(reconnected);
        reconnected.send('chat.auth', {
          token: this.chat.issue(client.sessionId),
        });
        this.event('reconnected', client.sessionId, {});
        return;
      } catch {
        // Reconnection expired; continue removing the disconnected player.
      }
    }
    this.state.players.delete(client.sessionId);
    this.bodies.delete(client.sessionId);
    this.budget.delete(client.sessionId);
    this.signalBudget.delete(client.sessionId);
    this.event('left', client.sessionId, {});
  }
  async onDispose() {
    this.releaseVoiceServices?.();
    this.realtime.dispose();
    this.agentSpeech.close();
    this.chat.clear();
    await this.queue;
    await this.store?.close();
    if (this.ownsActive) activeRoom = false;
  }
  getPresence(): WorldPresence {
    return {
      worldId: WORLD_ID,
      roomId: this.roomId,
      revision: this.state.revision,
      capacity: this.maxClients,
      persistence: this.store.mode,
      updatedAt: Date.now(),
      players: [...this.state.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        connected: p.connected,
      })),
    };
  }
  private snapshot(client: Client) {
    client.send('snapshot', {
      blocks: [...this.blocks.values()],
      revision: this.state.revision,
      persistence: this.store.mode,
    });
  }
  private reply(client: Client, id: string, ok: boolean, error?: string) {
    client.send('result', { id, ok, error, revision: this.state.revision });
  }
  private allow(client: Client, signaling = false) {
    const budget = signaling ? this.signalBudget : this.budget;
    const limit = signaling ? 120 : 45;
    const now = Date.now(),
      b = budget.get(client.sessionId) ?? { at: now, count: 0 };
    if (now - b.at > 1000) {
      b.at = now;
      b.count = 0;
    }
    b.count++;
    budget.set(client.sessionId, b);
    if (b.count > limit) {
      if (b.count === limit + 1) this.reply(client, '', false, 'rate-limited');
      return false;
    }
    return true;
  }
  private event(type: string, actor: string, data: unknown) {
    const event = { seq: ++this.seq, type, actor, data, at: Date.now() };
    this.events.push(event);
    if (this.events.length > 100) this.events.shift();
    this.broadcast('event', event);
  }
  private chatEvent(actor: string, data: ChatData) {
    const event = {
      actorKind: this.state.players.get(actor)?.kind,
      seq: ++this.seq,
      type: 'chat',
      actor,
      data,
      at: Date.now(),
    };
    this.events.push(event);
    if (this.events.length > 100) this.events.shift();
    for (const client of this.clients)
      if (visibleEvent(event, client.sessionId)) client.send('event', event);
    this.agentSpeech.enqueue(actor, data);
  }
  private observe(client: Client, id: string) {
    const self = this.state.players.get(client.sessionId)!;
    // Unlike the model summary, navigation must never silently truncate solids.
    const center = {
      x: Math.round(self.x),
      y: Math.round(self.y),
      z: Math.round(self.z),
    };
    const min = {
      x: Math.max(-LIMIT, center.x - 8),
      y: Math.max(0, center.y - 8),
      z: Math.max(-LIMIT, center.z - 8),
    };
    const max = {
      x: Math.min(LIMIT, center.x + 8),
      y: Math.min(MAX_Y, center.y + 8),
      z: Math.min(LIMIT, center.z + 8),
    };
    const body = this.bodies.get(client.sessionId)!;
    client.send('observation', {
      id,
      protocol: 1,
      revision: this.state.revision,
      self: self.toJSON(),
      radius: 8,
      motion: { grounded: body.grounded, vy: body.vy },
      navigation: {
        complete: true,
        revision: this.state.revision,
        min,
        max,
        blocks: [...this.blocks.values()].filter(
          (b) =>
            b.x >= min.x &&
            b.x <= max.x &&
            b.y >= min.y &&
            b.y <= max.y &&
            b.z >= min.z &&
            b.z <= max.z,
        ),
      },
      blocks: [...this.blocks.values()]
        .filter((b) => distance(self, b) <= 8)
        .sort((a, b) => distance(self, a) - distance(self, b))
        .slice(0, 500),
      players: [...this.state.players.values()]
        .filter((p) => distance(self, p) <= 8)
        .map((p) => p.toJSON()),
      events: this.events
        .filter((event) => visibleEvent(event, client.sessionId))
        .slice(-30),
      allowedActions: ['move', 'edit', 'chat', 'observe'],
    });
  }
}
