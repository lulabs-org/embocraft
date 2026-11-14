import type { WorldChat } from './services/chat.service';

/** Read-only access to synthesized Agent speech clips owned by the world room. */
export type AgentSpeechClips = { audio(id: string, viewer: string): Buffer };

/** Live world services used by chat HTTP routes. */
export type ChatRoutePort = {
  chat: WorldChat;
  agentSpeech?: AgentSpeechClips;
};
