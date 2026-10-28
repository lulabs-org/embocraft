import {
  aiCharacterPermissions,
  Session,
  createAgentRuntime,
  AgentRuntimeError,
} from '@voxel/agent-runtime';
import { agentConfig } from './config';

const abort = new AbortController();
let session: Session | undefined;
const stop = () => {
  abort.abort();
  // Close immediately even while an observation or join is awaiting a reply.
  void session?.close().catch(() => session?.room?.connection.close());
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const config = agentConfig();
  console.log(
    `AI 玩家 · ${config.model} · 任务驱动 · 保护上限 ${config.maxTurns} 次调用 · 放置${aiCharacterPermissions(config).place ? '开启' : '关闭'} · 拆除${aiCharacterPermissions(config).remove ? '开启' : '关闭'}`,
  );
  console.log(
    '附近方块、玩家昵称、聊天事件及 Agent 目标将发送至模型 API。Ctrl+C 退出。',
  );
  session = new Session();
  await session.join(config.name, 'ai-agent');
  if (
    !abort.signal.aborted &&
    (await session.observe()).self.kind !== 'ai-agent'
  )
    throw new AgentRuntimeError(
      '当前世界服务尚未加载 AI 玩家支持，请使用最新代码重启世界服务后再运行。',
      true,
    );
  if (!abort.signal.aborted)
    await session.request('agent.voice', {
      enabled: !!config.voiceReplies && aiCharacterPermissions(config).chat,
    });
  const runtime = createAgentRuntime({
    session,
    selfId: session.room.sessionId,
    log: console.log,
  });
  await runtime.runUntilSettled(config, abort.signal);
} catch (error) {
  if (!abort.signal.aborted) {
    console.error(
      error instanceof AgentRuntimeError || !session
        ? (error as Error).message
        : '无法连接世界或运行 Agent，请确认 SERVER_URL 和世界服务。',
    );
    process.exitCode = 1;
  }
} finally {
  abort.abort();
  await session?.close().catch(() => session?.room?.connection.close());
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
