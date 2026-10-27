import { AppError } from '../../core/errors/app-error';
import {
  CHAT_MIN_INTERVAL_MS,
  parseChatRoute,
  type ChatData,
  type Player,
} from '@voxel/shared';
import { ChatCredentials } from './credentials';
import { ChatAudioClips } from './audio-clips';
import { SpatialSpeech } from './spatial-speech';

/** Room-facing chat API; each stateful concern owns its own lifecycle. */
export class WorldChat {
  private credentials: ChatCredentials;
  private audioClips: ChatAudioClips;
  private spatialSpeech: SpatialSpeech;
  private sent = new Map<string, number>();

  constructor(
    private players: () => Iterable<Player>,
    private emit: (actor: string, data: ChatData) => void,
  ) {
    this.credentials = new ChatCredentials(players);
    this.audioClips = new ChatAudioClips(
      players,
      (actor, value) => this.route(actor, value),
      emit,
    );
    this.spatialSpeech = new SpatialSpeech(players, emit);
  }

  issue(id: string) {
    this.spatialSpeech.cancel(id);
    this.sent.delete(id);
    return this.credentials.issue(id);
  }

  revoke(id: string) {
    this.spatialSpeech.cancel(id);
    this.sent.delete(id);
    this.credentials.revoke(id);
  }

  authenticate(token: string) {
    return this.credentials.authenticate(token);
  }

  route(actor: string, value: unknown) {
    const route = parseChatRoute(value),
      players = [...this.players()];
    if (!players.some((p) => p.id === actor && p.connected))
      throw new AppError('你尚未连接世界。', 401);
    if (
      route.recipients.some(
        (id) =>
          id === actor || !players.some((p) => p.id === id && p.connected),
      )
    )
      throw new AppError('接收对象已离线或无效，请重新选择。');
    return route;
  }
  send(actor: string, value: unknown) {
    const route = this.route(actor, value),
      text = (value as { text?: unknown }).text;
    if (typeof text !== 'string' || !text.trim() || text.length > 240)
      throw new AppError('消息需为 1–240 字。');
    // Resolve typed public mentions too. Duplicate nicknames require the picker.
    if (route.scope === 'public') {
      const players = [...this.players()].filter(
        (p) => p.connected && p.id !== actor,
      );
      for (const player of players) {
        if (players.filter((p) => p.name === player.name).length !== 1)
          continue;
        const escaped = player.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (
          new RegExp(
            `(?:^|\\s)@${escaped}(?=$|\\s|[，。！？、,:;!?])`,
            'u',
          ).test(text) &&
          !route.recipients.includes(player.id)
        )
          route.recipients.push(player.id);
      }
      if (route.recipients.length > 8)
        throw new AppError('接收对象最多选择 8 位。');
    }
    if (Date.now() - (this.sent.get(actor) ?? 0) < CHAT_MIN_INTERVAL_MS)
      throw new AppError('发送过快，请稍候。', 429);
    this.sent.set(actor, Date.now());
    this.emit(actor, {
      ...route,
      text: text.trim(),
      kind: 'text',
      name: [...this.players()].find((p) => p.id === actor)!.name,
    });
  }
  beginUpload(actor: string, value: unknown) {
    return this.audioClips.beginUpload(actor, value);
  }

  endUpload(actor: string) {
    return this.audioClips.endUpload(actor);
  }

  publishAudio(
    actor: string,
    value: unknown,
    bytes: Buffer,
    durationMs: number,
    text: string,
  ) {
    return this.audioClips.publishAudio(actor, value, bytes, durationMs, text);
  }

  beginSpatial(actor: string) {
    return this.spatialSpeech.begin(actor);
  }

  claimSpatial(actor: string, id: string) {
    return this.spatialSpeech.claim(actor, id);
  }

  previewSpatial(actor: string, id: string) {
    return this.spatialSpeech.preview(actor, id);
  }

  publishSpatial(actor: string, id: string, text: string) {
    return this.spatialSpeech.publish(actor, id, text);
  }

  endSpatial(actor: string, id: string) {
    return this.spatialSpeech.end(actor, id);
  }

  cancelSpatial(actor: string) {
    return this.spatialSpeech.cancel(actor);
  }

  audio(id: string, viewer: string) {
    return this.audioClips.audio(id, viewer);
  }

  clear() {
    this.spatialSpeech.clear();
    this.credentials.clear();
    this.audioClips.clear();
    this.sent.clear();
  }
}
