import { refreshOnGatewayChange } from '../../../network/gateway';
import type { ProviderView } from '@voxel/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ConsoleFeedback } from '../useConsoleFeedback';
import { providersApi } from './api';
import { freshProvider } from './model';
export function useProvidersController(
  open: boolean,
  tab: string,
  feedback: ConsoleFeedback,
) {
  const { setError, setNotice, perform } = feedback;
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState(freshProvider());
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelFeedback, setModelFeedback] = useState<{
    error?: string;
    notice?: string;
  }>({});
  const modelRequest = useRef<AbortController | null>(null);
  const editingProvider = providers.find((p) => p.id === editing);
  const resetModels = () => {
    modelRequest.current?.abort();
    setLoadingModels(false);
    setModels([]);
    setModelFeedback({});
  };
  useEffect(() => {
    resetModels();
  }, [draft.type, draft.baseUrl, draft.apiKey, editing]);
  useEffect(() => {
    if (tab !== 'providers') {
      modelRequest.current?.abort();
      setLoadingModels(false);
    }
  }, [tab]);
  useEffect(() => {
    if (!open) return;
    setLoadingModels(false);
    const abort = new AbortController();
    const stop = refreshOnGatewayChange(
      async () => {
        await providersApi
          .listProviders(abort.signal)
          .then((list) => {
            if (!abort.signal.aborted) setProviders(list);
          })
          .catch((e) => {
            if (!abort.signal.aborted) setError(String(e.message));
          });
      },
      { resource: 'providers' },
    );
    return () => {
      stop();
      abort.abort();
      modelRequest.current?.abort();
    };
  }, [open, setError]);
  const readModels = async (id: string) => {
    modelRequest.current?.abort();
    const abort = new AbortController();
    modelRequest.current = abort;
    setLoadingModels(true);
    setModels([]);
    setError('');
    setNotice('');
    setModelFeedback({});
    try {
      const result = await providersApi.listModels(id, abort.signal);
      if (abort.signal.aborted) return;
      setModels(result.models);
      setModelFeedback({
        notice: `连接成功，发现 ${result.models.length} 个模型。可在默认模型 ID 中选择或填写，然后保存服务。`,
      });
    } catch (e) {
      if (!abort.signal.aborted)
        setModelFeedback({ error: (e as Error).message });
    } finally {
      if (!abort.signal.aborted) setLoadingModels(false);
    }
  };
  const editProvider = (p?: ProviderView) => {
    modelRequest.current?.abort();
    setLoadingModels(false);
    setModels([]);
    setError('');
    setNotice('');
    setEditing(p?.id);
    setDraft(
      p
        ? {
            name: p.name,
            type: p.type,
            baseUrl: p.baseUrl,
            defaultModel: p.defaultModel,
            apiKey: '',
          }
        : freshProvider(),
    );
  };
  const saveProvider = (
    e: FormEvent,
    onSaved: (saved: ProviderView, previous?: ProviderView) => void,
  ) => {
    e.preventDefault();
    void perform(async () => {
      const saved = await providersApi.saveProvider(draft, editing);
      setProviders(await providersApi.listProviders());
      setEditing(saved.id);
      setDraft((d) => ({ ...d, apiKey: '' }));
      onSaved(saved, editingProvider);
      setModels([]);
      setNotice('模型服务已保存。可在“AI 角色”中选择此服务。');
    });
  };

  const removeProvider = (
    onRemoved: (id: string, list: ProviderView[]) => void,
  ) =>
    perform(async () => {
      if (!editing) return;
      await providersApi.deleteProvider(editing);
      const list = await providersApi.listProviders();
      setProviders(list);
      onRemoved(editing, list);
      editProvider();
      setNotice('模型服务已删除。');
    });
  return {
    providers,
    editing,
    draft,
    setDraft,
    models,
    loadingModels,
    modelFeedback,
    editingProvider,
    resetModels,
    readModels,
    editProvider,
    saveProvider,
    removeProvider,
  };
}
