import { refreshOnGatewayChange } from '../../../network/gateway';
import { aiCharacterPermissions, type ProviderView } from '@voxel/shared';
import type { PublicAICharacterView } from '@voxel/shared/management';
import { useEffect, useState } from 'react';
import type { ConsoleFeedback } from '../useConsoleFeedback';
import { aiCharactersApi } from './api';
import { initialAICharacter } from './model';
export function useAICharactersController(
  open: boolean,
  initialTab: 'characters' | undefined,
  providers: ProviderView[],
  resetModels: () => void,
  feedback: ConsoleFeedback,
) {
  const { setError, setNotice, perform, mutation, jobsRevision } = feedback;
  const [jobs, setJobs] = useState<PublicAICharacterView[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [joinOnCreate, setJoinOnCreate] = useState(true);
  const [agent, setAgent] = useState(initialAICharacter);
  const [editingAgent, setEditingAgent] = useState<string>();
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [pollError, setPollError] = useState('');
  const selected = providers.find((p) => p.id === agent.providerId);
  useEffect(() => {
    if (providers[0])
      setAgent((a) => ({
        ...a,
        providerId: a.providerId || providers[0].id,
        model: a.providerId ? a.model : providers[0].defaultModel,
      }));
  }, [providers]);
  useEffect(() => {
    if (!open) return;
    if (initialTab) setShowAgentForm(false);
    const abort = new AbortController();
    const poll = async () => {
      const revision = jobsRevision.current;
      try {
        const list = await aiCharactersApi.listAgents(abort.signal);
        if (abort.signal.aborted) return;
        if (!mutation.current && revision === jobsRevision.current) {
          setJobs(list);
          setPollError('');
          setLoadingJobs(false);
        }
      } catch {
        if (!abort.signal.aborted) {
          setPollError('无法刷新 AI 角色状态，请检查世界服务连接。');
          setLoadingJobs(false);
        }
      }
    };
    const stop = refreshOnGatewayChange(poll);
    return () => {
      abort.abort();
      stop();
    };
  }, [open, initialTab, jobsRevision, mutation]);
  const openAgentEditor = (job?: PublicAICharacterView) => {
    resetModels();
    setEditingAgent(job?.id);
    if (job) setSelectedAgentId(job.id);
    setJoinOnCreate(true);
    setAgent(
      job
        ? {
            ...job,
            taskLimitsEnabled: job.taskLimitsEnabled ?? false,
            model:
              providers.find((p) => p.id === job.providerId)?.defaultModel ??
              '',
          }
        : {
            ...initialAICharacter,
            providerId: providers[0]?.id ?? '',
            model: providers[0]?.defaultModel ?? '',
          },
    );
    setError('');
    setNotice('');
    setShowAgentForm(true);
  };
  const selectAgent = (id: string) => {
    setSelectedAgentId(id);
    setShowAgentForm(false);
    setError('');
    setNotice('');
  };
  const chooseProvider = (id: string) => {
    resetModels();
    setError('');
    setNotice('');
    const p = providers.find((p) => p.id === id);
    setAgent((a) => ({
      ...a,
      providerId: id,
      model: p?.defaultModel ?? '',
      thinking: 'disabled',
    }));
  };
  const saveAgent = () =>
    perform(async () => {
      if (!selected?.defaultModel.trim())
        throw new Error('请先在模型服务中配置并保存模型 ID。');
      const {
        timeoutMs,
        maxTokens,
        thinking,
        reasoningEffort,
        taskLimitsEnabled,
        maxTurns,
        tokenBudget,
        taskTimeoutMs,
        intervalMode,
        intervalMs,
        intervalMinMs,
        intervalMaxMs,
        ...profile
      } = agent;
      const saved = await aiCharactersApi.saveAgent(
        {
          ...profile,
          model: selected.defaultModel,
          taskLimitsEnabled: !!taskLimitsEnabled,
          maxTurns,
          tokenBudget,
          taskTimeoutMs,
          ...(editingAgent
            ? {}
            : {
                taskLimitsEnabled: !!taskLimitsEnabled,
                maxTurns,
                tokenBudget,
                taskTimeoutMs,
                intervalMode,
                intervalMs: intervalMode === 'fixed' ? intervalMs : 3000,
                intervalMinMs: intervalMode === 'random' ? intervalMinMs : 4000,
                intervalMaxMs: intervalMode === 'random' ? intervalMaxMs : 8000,
                joinWorld: joinOnCreate,
              }),
        },
        editingAgent,
      );
      setJobs(await aiCharactersApi.listAgents());
      setSelectedAgentId(saved.id);
      if (editingAgent) {
        setAgent({
          ...saved,
          taskLimitsEnabled: saved.taskLimitsEnabled ?? false,
          model: selected.defaultModel,
        });
        setEditingAgent(saved.id);
        setShowAgentForm(true);
      } else {
        setShowAgentForm(false);
      }
      setNotice(
        editingAgent
          ? 'AI 角色设置已保存。'
          : !joinOnCreate
            ? 'AI 角色已创建，可在“AI 角色”页上线。'
            : aiCharacterPermissions(agent).chat
              ? 'AI 角色正在加入世界待命，可通过私聊或 @ 交流。'
              : 'AI 角色正在加入世界待命。发送聊天已关闭，可在控制台安排任务和查看进展。',
      );
    });
  const joinAgent = (job: PublicAICharacterView) =>
    perform(async () => {
      await aiCharactersApi.joinAgent(job.id);
      setJobs(await aiCharactersApi.listAgents());
      setNotice('AI 角色正在上线待命，原任务不会自动执行。');
    });
  const stopAgent = (job: PublicAICharacterView) =>
    perform(async () => {
      await aiCharactersApi.stopAgent(job.id);
      setJobs(await aiCharactersApi.listAgents());
    });
  const deleteAgent = (job: PublicAICharacterView) =>
    perform(async () => {
      await aiCharactersApi.deleteAgent(job.id);
      setJobs((list) => list.filter((item) => item.id !== job.id));
      setSelectedAgentId(undefined);
      setEditingAgent(undefined);
      setShowAgentForm(false);
      setNotice(`已删除 AI 角色“${job.name}”。`);
    });
  const providerSaved = (saved: ProviderView, previous?: ProviderView) =>
    setAgent((a) =>
      !a.providerId || a.providerId === saved.id
        ? {
            ...a,
            providerId: saved.id,
            model: saved.defaultModel,
            thinking: previous?.type === saved.type ? a.thinking : 'disabled',
          }
        : a,
    );
  const providerRemoved = (id: string, list: ProviderView[]) =>
    setAgent((a) =>
      a.providerId === id
        ? {
            ...a,
            providerId: list[0]?.id ?? '',
            model: list[0]?.defaultModel ?? '',
          }
        : a,
    );
  const refreshJobs = async () => setJobs(await aiCharactersApi.listAgents());
  return {
    refreshJobs,
    jobs,
    setJobs,
    loadingJobs,
    selectedAgentId,
    selectAgent,
    joinOnCreate,
    setJoinOnCreate,
    agent,
    setAgent,
    editingAgent,
    showAgentForm,
    setShowAgentForm,
    pollError,
    selected,
    openAgentEditor,
    chooseProvider,
    saveAgent,
    joinAgent,
    stopAgent,
    deleteAgent,
    providerSaved,
    providerRemoved,
  };
}

export type AICharactersController = ReturnType<
  typeof useAICharactersController
>;
