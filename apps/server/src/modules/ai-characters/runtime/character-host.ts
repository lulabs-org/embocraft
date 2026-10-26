import { aiCharacterPermissions, type AICharacterView } from '@voxel/shared';
import {
  AgentAttention,
  AgentRuntimeError,
  type AgentConfig,
} from '@voxel/agent-runtime';
import { appendAICharacterLog } from '../domain/activity-log';
import type { Job } from './job';
import type { SavedProvider } from '../../providers/domain/model';
import {
  captureTask,
  currentRun,
  executionConfigOverrides,
  beginChatExecution,
} from '../../tasks/runtime/execution';
import { executionState } from './task-adapter';
import { resolveInferenceDefaults } from '../../providers/domain/inference';
import { handleWorldEvent } from './world-event-handler';
import type { ExecutionContext } from './execution-context';

export type { ExecutionContext };

/**
 * AICharacterHost 代表单个 AI 角色在游戏世界中的会话运行宿主，
 * 负责维护 Colyseus 房间长连接与驱动 AgentRunner 执行管道。
 */
export class AICharacterHost {
  constructor(
    private job: Job,
    private ctx: ExecutionContext,
  ) {}

  async run(provider: SavedProvider, run = true): Promise<void> {
    const { job, ctx } = this;
    const log = (message: string) => {
      const safe = provider.apiKey
        ? message.split(provider.apiKey).join('[已隐藏]')
        : message;
      appendAICharacterLog(job.view, safe);
      const record = currentRun(executionState(job));
      if (record) record.logs = [...record.logs, safe].slice(-40);
      ctx.persist();
    };

    let finalStatus: AICharacterView['status'] = 'idle';

    try {
      captureTask(executionState(job));
      await ctx.save();
      if (job.abort.signal.aborted || ctx.closing()) return;

      const inferenceDefaults = resolveInferenceDefaults(
        job.view.model,
        provider.type,
      );
      const config: AgentConfig = {
        ...inferenceDefaults,
        ...job.view,
        ...executionConfigOverrides(executionState(job)),
        apiKey: provider.apiKey,
      };

      if (!job.session) {
        const session = ctx.dependencies.session(ctx.serverUrl);
        job.attention = new AgentAttention();
        job.session = session;
        await session.join(job.view.name, 'ai-agent');
        job.view.sessionId = session.room.sessionId;

        session.onEvent = (event) => {
          if (
            ctx.closing() ||
            job.controlling ||
            job.session !== session ||
            !['running', 'idle', 'failed'].includes(job.view.status)
          )
            return;
          if (!job.attention.accept(event, session.room.sessionId)) return;

          handleWorldEvent(event, job, session, ctx, log);
        };

        session.room.onMessage(
          'agent.speech.error',
          (value: { message: string }) => log(`语音：${value.message}`),
        );

        session.room.onLeave(() => {
          ctx.voiceServices?.unbind(session.room.sessionId);
          if (job.session !== session) return;
          job.session = undefined;
          delete job.view.sessionId;
          job.abort.abort();
          if (job.view.status !== 'stopping') {
            job.view.status = 'failed';
            log('世界连接已断开，可点击继续运行重新加入。');
          }
          ctx.persist();
        });

        log('已加入世界。');
      }

      const voiceResult = await job.session.request('agent.voice', {
        enabled:
          !!job.view.voiceReplies && aiCharacterPermissions(job.view).chat,
      });
      ctx.bindVoice(job);
      if (!voiceResult.ok) log('语音回复开关未生效，请检查服务器版本。');

      if (!job.abort.signal.aborted && run) {
        job.view.status = 'running';
        if (!job.memory.effects.follow || job.attention.pending)
          log(job.attention.pending ? '处理当前消息。' : '启动 Pi 任务执行。');

        await ctx.dependencies.runner(config, provider).run({
          session: job.session,
          config,
          defaults: {
            ...inferenceDefaults,
            ...job.view,
            apiKey: provider.apiKey,
          },
          signal: job.abort.signal,
          memory: job.memory,
          attention: job.attention,
          log,
          checkpoint: async () => {
            await ctx.save();
          },
          hooks: {
            beforeNewTask: (_task, previousMemory) =>
              beginChatExecution(
                executionState(job),
                previousMemory,
                config,
                ctx.save,
              ),
          },
        });
      }

      finalStatus =
        job.abort.signal.aborted && !job.controlling ? 'failed' : 'idle';
      if (finalStatus === 'idle' && !job.memory.effects.follow)
        log(
          run
            ? '本次唤醒结束，按任务状态安排下一次检查。'
            : '已在世界中待命；可通过私聊或 @ 交流，也可以安排新任务。',
        );
    } catch (error) {
      finalStatus = 'failed';
      if (!job.abort.signal.aborted)
        log(
          error instanceof AgentRuntimeError
            ? error.message
            : '无法加入世界或执行动作，请检查世界连接和模型配置。',
        );
    } finally {
      if (!job.view.sessionId) {
        await job.session
          ?.close()
          .catch(() => job.session?.room?.connection.close());
        job.session = undefined;
      }
      if (job.view.status !== 'stopping') job.view.status = finalStatus;
      ctx.persist();
      ctx.schedule(job);
    }
  }
}
