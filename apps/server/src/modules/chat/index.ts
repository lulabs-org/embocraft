import { ChatStore } from './persistence/chat-store';

export { WorldChat } from './services/chat.service';
export { installChatRoutes } from './routes/chats.routes';
export { visibleEvent } from './domain/visibility';
export { ChatStore } from './persistence/chat-store';

/** 默认的聊天消息存储单例 */
export const defaultChatStore = new ChatStore();
