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
    '玩家要求跟随、移动或其他世界行动时，立即委托游戏 Agent，包含玩家的原始请求；不要要求玩家另外创建任务。委托结果可能只是聊天回复，不是动作已开始或完成的证明。只根据明确的执行结果描述行动；结果不明确时如实说明正在确认。',
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
        finish(
          undefined,
          `游戏 Agent 的文字回复：${data.text}\n这条回复本身不是动作已启动或完成的确认；如无明确的工具结果，不要声称正在跟随或已经完成。`,
        );
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
