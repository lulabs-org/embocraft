import { randomUUID } from 'node:crypto';
import { aiCharacterPermissions, type AICharacterView } from '@voxel/shared';
import { AppError } from '../../../core/errors/app-error';
import { boolean, object, text } from '../../../core/http/validation';
import type { ProviderRuntimePort } from '../../providers';
import { markJoined, modelChanged, pauseTaskForHost } from '../../tasks';
import { appendAICharacterLog } from '../domain/activity-log';
import {
  aiCharacterProfileInput,
  validateAICharacter,
} from '../domain/character-settings';
import { executionState } from '../integrations/task-execution-adapter';
import type { CharacterVoiceCoordinator } from '../integrations/voice-coordinator';
import type { CharacterExecutionService } from '../runtime/character-execution';
import {
  active,
  isJobBusy,
  resident,
  type AICharacterRegistry,
  type Job,
} from '../runtime/character-registry';
import type { CharacterRecord } from '../persistence/character-record';
import type { CharacterChanges } from '../../../persistence/management-archive';
import type { AICharacterWakeScheduler } from '../runtime/wake-scheduler';

type ManagementContext = {
  jobs: AICharacterRegistry;
  providers: ProviderRuntimePort;
  voice: CharacterVoiceCoordinator;
  scheduler: AICharacterWakeScheduler;
  execution: CharacterExecutionService;
  closing: () => boolean;
  findJob: (id: string) => Job | undefined;
  result: (id: string) => Promise<AICharacterView>;
  read: (id: string) => Promise<CharacterRecord>;
  insert: (record: CharacterRecord) => Promise<void>;
  join: (id: string) => Promise<AICharacterView>;
  save: (changes?: CharacterChanges) => Promise<void>;
  detachAgent: (id: string, name: string) => () => void;
};

/** Owns character configuration changes and their lifecycle coordination. */
export class CharacterManagementService {
  constructor(private readonly context: ManagementContext) {}

  async create(value: unknown) {
    if (this.context.closing()) throw new AppError('世界服务正在关闭。', 503);
    const input = aiCharacterProfileInput(value);
    const provider = await this.context.providers.getRuntime(
      text(input.providerId, '模型服务', 80),
    );
    const settings = validateAICharacter(input, provider);
    const joinWorld = boolean(input.joinWorld, true);
    await this.context.voice.checkVoice(settings);
    if (this.context.closing()) throw new AppError('世界服务正在关闭。', 503);
    if (
      joinWorld &&
      [...this.context.jobs.values()].filter(resident).length >= 4
    )
      throw new AppError(
        '最多同时在线 4 个受管理的 Agent（含待命），请先关闭一个。',
        409,
      );
    const record: CharacterRecord = {
      ...settings,
      id: randomUUID(),
      status: 'stopped',
      createdAt: Date.now(),
      logEntries: [],
    };
    await this.context.insert(record);
    return joinWorld
      ? this.context.join(record.id)
      : this.context.result(record.id);
  }

  async join(id: string, restoring = false) {
    if (this.context.closing()) throw new AppError('世界服务正在关闭。', 503);
    const job = this.context.findJob(id);
    if (!job) throw new AppError('Agent 不存在。', 404);
    if (resident(job) || isJobBusy(job))
      throw new AppError('角色已在线或正在更新，请稍候。', 409);
    if ([...this.context.jobs.values()].filter(resident).length >= 4)
      throw new AppError(
        '最多同时在线 4 个 Agent，请先让一个角色离开世界。',
        409,
      );
    const previousStatus = job.view.status;
    job.updating = true;
    job.view.status = 'joining';
    this.context.jobs.set(id, job);
    job.abort = new AbortController();
    try {
      const provider = await this.context.providers.getRuntime(
        job.view.providerId,
      );
      if (
        this.context.closing() ||
        this.context.findJob(id) !== job ||
        job.abort.signal.aborted ||
        job.view.status !== 'joining'
      )
        throw new AppError('角色状态已变化，请刷新后重试。', 409);
      const settings = validateAICharacter(job.view, provider);
      await this.context.voice.checkVoice(settings);
      if (
        this.context.closing() ||
        this.context.findJob(id) !== job ||
        job.abort.signal.aborted ||
        job.view.status !== 'joining'
      )
        throw new AppError('角色状态已变化，请刷新后重试。', 409);
      if ([...this.context.jobs.values()].filter(resident).length > 4)
        throw new AppError(
          '最多同时在线 4 个 Agent，请先让一个角色离开世界。',
          409,
        );
      this.context.scheduler.cancel(job.view.id);
      if (!restoring) markJoined(executionState(job));
      Object.assign(job.view, settings, {
        providerName: provider.name,
        status: 'joining',
      });
      job.runtime.clearMessages();
      await this.context.save({ profiles: { [id]: settings } });
      job.done = this.context.execution.execute(job, provider, false);
      return this.context.result(id);
    } catch (error) {
      if (job.view.status === 'joining') job.view.status = previousStatus;
      throw error;
    } finally {
      job.updating = false;
    }
  }

  async update(id: string, value: unknown) {
    if (this.context.closing()) throw new AppError('世界服务正在关闭。', 503);
    const job = this.context.findJob(id);
    if (!job) throw new AppError('Agent 不存在。', 404);
    const input = aiCharacterProfileInput(value);
    if (active(job.view.status) || isJobBusy(job))
      throw new AppError('请等待 Agent 待命，或关闭后再修改参数。', 409);
    job.updating = true;
    try {
      const stored = await this.context.read(id);
      const provider = await this.context.providers.getRuntime(
        text(input.providerId, '模型服务', 80, stored.providerId),
      );
      if (
        this.context.closing() ||
        this.context.findJob(id) !== job ||
        active(job.view.status)
      )
        throw new AppError('角色状态已变化，请刷新后重试。', 409);
      const settings = validateAICharacter(
        {
          ...stored,
          ...input,
          permissions:
            input.permissions !== undefined
              ? input.permissions
              : stored.permissions,
        },
        provider,
      );
      await this.context.voice.checkVoice(settings);
      if (
        this.context.closing() ||
        this.context.findJob(id) !== job ||
        active(job.view.status)
      )
        throw new AppError('角色状态已变化，请刷新后重试。', 409);
      const session = job.session;
      if (
        session &&
        (!!settings.voiceReplies && aiCharacterPermissions(settings).chat) !==
          (!!job.view.voiceReplies && aiCharacterPermissions(job.view).chat)
      ) {
        const result = await this.context.voice.syncSessionVoice(
          session,
          !!settings.voiceReplies && aiCharacterPermissions(settings).chat,
        );
        if (!result.ok || job.session !== session || active(job.view.status))
          throw new AppError('语音开关未保存，请刷新后重试。', 409);
      }
      if (session && settings.name !== job.view.name) {
        const result = await session.request('rename', { name: settings.name });
        if (!result.ok || job.session !== session || active(job.view.status))
          throw new AppError('角色状态已变化，未保存参数，请刷新后重试。', 409);
      }
      await this.context.voice.bindVoice(job, settings);
      if (
        this.context.closing() ||
        this.context.findJob(id) !== job ||
        job.session !== session ||
        active(job.view.status)
      )
        throw new AppError('角色状态已变化，请刷新后重试。', 409);
      if (
        settings.providerId !== job.view.providerId ||
        settings.model !== job.view.model
      ) {
        this.context.scheduler.cancel(job.view.id);
        modelChanged(executionState(job));
        job.runtime.clearMessages();
      } else if (
        JSON.stringify(aiCharacterPermissions(settings)) !==
          JSON.stringify(aiCharacterPermissions(job.view)) ||
        JSON.stringify(settings.skills) !== JSON.stringify(job.view.skills)
      ) {
        this.context.scheduler.cancel(job.view.id);
        job.runtime.clearMessages();
        pauseTaskForHost(
          executionState(job),
          '角色技能或动作权限已修改，进度已保留，请确认后继续。',
        );
        appendAICharacterLog(
          job.view,
          '角色能力已更新；后续按新权限重新规划，已有进度保留。',
        );
      }
      Object.assign(job.view, settings, { providerName: provider.name });
      await this.context.save({ profiles: { [id]: settings } });
      return this.context.result(id);
    } finally {
      job.updating = false;
      this.context.execution.schedule(job);
    }
  }

  async setVoice(id: string, value: unknown) {
    const job = this.context.findJob(id);
    if (!job) throw new AppError('Agent 不存在。', 404);
    if (
      this.context.closing() ||
      isJobBusy(job) ||
      ['joining', 'stopping'].includes(job.view.status)
    )
      throw new AppError('Agent 状态正在更新，请稍候。', 409);
    const enabled = boolean(object(value).enabled, false);
    if (enabled && !aiCharacterPermissions(job.view).chat)
      throw new AppError('发送聊天权限已关闭，不能开启语音回复。');
    job.updating = true;
    try {
      await this.context.voice.checkVoice({
        ...job.view,
        voiceReplies: enabled,
      });
      if (this.context.closing() || this.context.findJob(id) !== job)
        throw new AppError('角色状态已变化，请刷新后重试。', 409);
      const session = job.session;
      if (session?.room) {
        const result = await this.context.voice.syncSessionVoice(
          session,
          enabled,
        );
        if (!result.ok || job.session !== session)
          throw new AppError('语音开关未生效，请重试。', 409);
      }
      await this.context.voice.bindVoice(job, {
        ...job.view,
        voiceReplies: enabled,
      });
      if (
        this.context.closing() ||
        this.context.findJob(id) !== job ||
        job.session !== session ||
        ['joining', 'stopping'].includes(job.view.status)
      )
        throw new AppError('角色状态已变化，请刷新后重试。', 409);
      job.view.voiceReplies = enabled;
      await this.context.save({
        profiles: { [id]: { voiceReplies: enabled } },
      });
      return this.context.result(id);
    } finally {
      job.updating = false;
      this.context.execution.schedule(job);
    }
  }

  async remove(id: string) {
    const job = this.context.findJob(id);
    if (!job) throw new AppError('Agent 不存在。', 404);
    if (this.context.closing() || isJobBusy(job))
      throw new AppError('Agent 状态正在更新，请稍候。', 409);
    job.controlling = true;
    try {
      this.context.execution.stop(id);
      await job.done;
      const restoreTasks = this.context.detachAgent(id, job.view.name);
      try {
        await this.context.save({ remove: [id] });
        this.context.jobs.delete(id);
      } catch (error) {
        restoreTasks();
        throw error;
      }
    } finally {
      job.controlling = false;
    }
  }
}
