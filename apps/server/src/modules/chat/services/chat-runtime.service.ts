import type { WorldChat } from './chat.service';

/** Read-only access to synthesized Agent speech clips owned by the world room. */
export type AgentSpeechClips = { audio(id: string, viewer: string): Buffer };

export type ChatRuntime = {
  chat?: WorldChat;
  agentSpeech?: AgentSpeechClips;
};

let activeRuntime: ChatRuntime = {};

export function bindChatRuntime(
  chat: WorldChat,
  agentSpeech?: AgentSpeechClips,
): () => void {
  const current: ChatRuntime = { chat, agentSpeech };
  activeRuntime = current;
  return () => {
    if (activeRuntime === current) activeRuntime = {};
  };
}

export function getActiveChatRuntime(): ChatRuntime {
  return activeRuntime;
}

