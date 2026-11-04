import {
  aiCharacterPermissions,
  spatialMix,
  SPEECH_HEARING_THRESHOLD,
  type AICharacterView,
  type ChatData,
} from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import type { WorldRoom } from '../../world';
import type { AuthorizedLiveConversation } from '../sockets/live-voice.socket';

type WorldProvider = () => WorldRoom | undefined;
type CharactersProvider = () => AICharacterView[];

/** Bind a live conversation to the authenticated human, a real Agent, and hearing range. */
export function authorizeWorldLiveVoice(
  worldProvider: WorldProvider,
  characters: CharactersProvider,
  token: string,
  agentId: string,
): AuthorizedLiveConversation {
  const world = worldProvider();
  if (!world) throw new AppError('世界尚未连接。', 503);
  const actorId = world.chat.authenticate(token);
  const character = characters().find((item) => item.sessionId === agentId);
  if (!character?.liveVoiceServiceId || !aiCharacterPermissions(character).chat)
    throw new AppError('此 Agent 未启用实时语音对话。', 409);
  const serviceId = character.liveVoiceServiceId;
  const valid = () => {
    if (worldProvider() !== world) return false;
    try {
      if (world.chat.authenticate(token) !== actorId) return false;
    } catch {
      return false;
    }
    const player = world.state.players.get(actorId),
      agent = world.state.players.get(agentId);
    const current = characters().find(
      (item) => item.id === character.id && item.sessionId === agentId,
    );
    return (
      !!player?.connected &&
      player.kind === 'human' &&
      !!agent?.connected &&
      agent.kind === 'ai-agent' &&
      !!current &&
      current.liveVoiceServiceId === serviceId &&
      aiCharacterPermissions(current).chat &&
      spatialMix(player, agent).gain >= SPEECH_HEARING_THRESHOLD &&
      spatialMix(agent, player).gain >= SPEECH_HEARING_THRESHOLD
    );
  };
  if (!valid()) throw new AppError('玩家或 Agent 已离开对话范围。', 409);
  const actor = world.state.players.get(actorId)!,
    agent = world.state.players.get(agentId)!;
  const instructions = [
    `你是在游戏世界中的 Agent 玩家，名字是 ${JSON.stringify(character.name)}。`,
    `角色设定：${character.roleDescription || '与附近玩家友好交流。'}`,
    `正在与你对话的玩家是 ${JSON.stringify(actor.name)}。你的位置是 (${Math.round(agent.x)}, ${Math.round(agent.y)}, ${Math.round(agent.z)})。`,
    '需要查看世界、执行行动或处理游戏任务时，委托游戏 Agent；只根据实际返回结果描述行动，不得声称未执行的任务已经完成。',
  ].join('\n');
  const delegate = (request: string, signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      if (signal.aborted || !valid())
        return reject(new Error('conversation ended'));
      if (!request.trim() || request.length > 240)
        return reject(new Error('request too long'));
      let done = false;
      let unsubscribe: () => void = () => {};
      const finish = (error?: Error, result?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        unsubscribe();
        if (error) reject(error);
        else resolve(result ?? '');
      };
      const abort = () => finish(new Error('conversation ended'));
      const timer = setTimeout(
        () => finish(new Error('agent reply timeout')),
        45000,
      );
      signal.addEventListener('abort', abort, { once: true });
      unsubscribe = world.onLiveVoiceChat((sender: string, data: ChatData) => {
        if (
          sender !== agentId ||
          data.scope !== 'private' ||
          !data.recipients.includes(actorId) ||
          !valid()
        )
          return false;
        finish(undefined, data.text);
        return true;
      });
      try {
        world.chat.send(actorId, {
          scope: 'private',
          recipients: [agentId],
          text: request,
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error('send failed'));
      }
    });
  const publishTranscript = (text: string) => {
    if (valid()) world.publishLiveVoiceTranscript(agentId, actorId, text);
  };
  const publishHumanTranscript = (text: string) => {
    if (valid()) world.publishLiveVoiceTranscript(actorId, actorId, text);
  };
  return {
    actorId,
    agentId,
    serviceId,
    instructions,
    valid,
    delegate,
    publishTranscript,
    publishHumanTranscript,
  };
}
