import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_BAILIAN_ASR,
  DEFAULT_WHISPER_ASR,
  type AsrServiceView,
} from '@voxel/shared';
import { voiceApi } from './api';
import { refreshAsrSelections, syncAsrChoice } from './asr-selection';
import {
  deleteBrowserAsrService,
  migrateBrowserAsrServices,
  saveBrowserAsrService,
  type AsrProvider,
  type BrowserAsrService,
  type WebAsrDraft,
  type WebAsrService,
} from './browser-asr-services';

const fresh = (provider: AsrProvider = 'bailian'): WebAsrDraft =>
  provider === 'browser'
    ? { provider, name: '', language: 'zh-CN' }
    : provider === 'whisper'
      ? { ...DEFAULT_WHISPER_ASR, provider, name: '' }
      : { ...DEFAULT_BAILIAN_ASR, provider, name: '', apiKey: '' };
const clearSecret = (draft: WebAsrDraft): WebAsrDraft =>
  draft.provider === 'whisper' || draft.provider === 'browser'
    ? draft
    : { ...draft, apiKey: '' };
const formFor = (id: string, saved?: WebAsrService) => ({
  id,
  draft: saved
    ? saved.provider === 'whisper' || saved.provider === 'browser'
      ? { ...saved }
      : { ...saved, apiKey: '' }
    : fresh(),
  dirty: id === 'new',
});

export function useAsrServices(active: boolean) {
  const [remoteServices, setRemoteServices] = useState<AsrServiceView[]>([]);
  const [browserServices, setBrowserServices] = useState<BrowserAsrService[]>(
    [],
  );
  const services: WebAsrService[] = [...remoteServices, ...browserServices];
  const [form, setForm] = useState(() => formFor('new'));
  const browserMode = form.draft.provider === 'browser';
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [localError, setLocalError] = useState('');
  const [remoteError, setRemoteError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    if (!active) return;
    try {
      const values = migrateBrowserAsrServices(window.localStorage);
      setBrowserServices(values);
      setLocalError('');
      setForm((previous) => {
        if (!previous.id.startsWith('browser-asr-')) return previous;
        const saved = values.find((value) => value.id === previous.id);
        return saved
          ? formFor(saved.id, saved)
          : { id: 'new', draft: fresh('browser'), dirty: true };
      });
    } catch (e) {
      setLocalError(
        e instanceof Error ? e.message : '无法读取浏览器识别配置。',
      );
    }
  }, [active, retry]);
  useEffect(() => {
    setLoaded(false);
    setSaving(false);
    setForm((previous) => ({
      ...previous,
      draft: clearSecret(previous.draft),
    }));
    if (!active || browserMode) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    request.current = abort;
    setLoading(true);
    setRemoteError('');
    void voiceApi
      .listAsrServices(
        AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      )
      .then((values) => {
        if (abort.signal.aborted) return;
        setRemoteServices(values);
        void refreshAsrSelections();
        setLoaded(true);
        setForm((previous) => {
          // A delayed list response must not overwrite a new/edited/local draft.
          if (
            previous.id === 'new' ||
            previous.draft.provider === 'browser' ||
            previous.dirty
          )
            return previous;
          const saved = values.find((v) => v.id === previous.id);
          return saved ? formFor(saved.id, saved) : formFor('new');
        });
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setRemoteError(e instanceof Error ? e.message : '读取识别服务失败。');
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => request.current?.abort();
  }, [active, retry, browserMode]);
  const choose = (id: string) => {
    setForm(
      formFor(
        id,
        services.find((v) => v.id === id),
      ),
    );
    setError('');
    setNotice('');
  };
  const change = (patch: Partial<WebAsrDraft>) => {
    setForm((previous) => ({
      ...previous,
      draft: { ...previous.draft, ...patch } as WebAsrDraft,
      dirty: true,
    }));
    setError('');
    setNotice('');
  };
  const mutate = async (remove: boolean) => {
    if (
      !active ||
      (!browserMode && loading) ||
      saving ||
      (remove && form.id === 'new')
    )
      return;
    setError('');
    setNotice('');
    if (form.draft.provider === 'browser') {
      try {
        if (remove) {
          setBrowserServices(
            deleteBrowserAsrService(window.localStorage, form.id),
          );
          syncAsrChoice(form.id);
          void refreshAsrSelections(true);
          setForm({ id: 'new', draft: fresh('browser'), dirty: true });
          setNotice('浏览器识别服务已删除。');
        } else {
          const { saved, services: values } = saveBrowserAsrService(
            window.localStorage,
            form.draft,
            form.id === 'new' ? undefined : form.id,
          );
          setBrowserServices(values);
          syncAsrChoice(saved.id, saved);
          setForm(formFor(saved.id, saved));
          setNotice('已保存到当前浏览器。可继续添加其他语言配置，或录音试用。');
        }
        setLocalError('');
      } catch (e) {
        setError(
          `保存或删除浏览器识别配置失败：${e instanceof Error ? e.message : '浏览器存储不可用。'}`,
        );
      }
      return;
    }
    const abort = new AbortController();
    request.current = abort;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]);
    setSaving(true);
    try {
      if (remove) {
        await voiceApi.deleteAsrService(form.id, signal);
        if (abort.signal.aborted) return;
        setRemoteServices((values) => values.filter((v) => v.id !== form.id));
        syncAsrChoice(form.id);
        void refreshAsrSelections(true);
        setForm({ id: 'new', draft: fresh(form.draft.provider), dirty: true });
        setNotice('识别服务已删除。');
      } else {
        const saved = await voiceApi.saveAsrService(
          form.draft,
          signal,
          form.id === 'new' ? undefined : form.id,
        );
        if (abort.signal.aborted) return;
        setRemoteServices((values) =>
          values.some((v) => v.id === saved.id)
            ? values.map((v) => (v.id === saved.id ? saved : v))
            : [...values, saved],
        );
        syncAsrChoice(saved.id, saved);
        void refreshAsrSelections(true);
        setForm(formFor(saved.id, saved));
        setNotice(
          '识别服务已保存。可从左侧添加更多服务，或开始录音试用当前服务。',
        );
      }
    } catch (e) {
      if (!abort.signal.aborted)
        setError(e instanceof Error ? e.message : '识别服务操作失败。');
    } finally {
      if (!abort.signal.aborted) setSaving(false);
    }
  };
  return {
    services,
    ...form,
    selected: services.find((v) => v.id === form.id),
    loading: !browserMode && loading,
    saving,
    loaded,
    error: error || localError || (!browserMode ? remoteError : ''),
    notice,
    canAdd: remoteServices.length < 20 || browserServices.length < 20,
    choose,
    change,
    changeProvider: (provider: AsrProvider) => {
      if (form.id !== 'new') return;
      setForm({
        id: 'new',
        draft: { ...fresh(provider), name: form.draft.name },
        dirty: true,
      });
      setError('');
      setNotice('');
    },
    save: () => mutate(false),
    remove: () => mutate(true),
    reload: () => {
      setError('');
      setNotice('');
      setRetry((n) => n + 1);
    },
  };
}
