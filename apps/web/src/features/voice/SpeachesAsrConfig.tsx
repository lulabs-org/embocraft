import { useEffect, useState } from 'react';
import type { WhisperAsrDraft, WhisperAsrView } from '@voxel/shared';
import { useI18n } from '../../i18n';
import { SpeachesModelSelect } from '../../components/audio/SpeachesModelSelect';
import { voiceApi } from './api';

export function SpeachesAsrConfig({
  draft,
  saved,
  active,
  onChange,
}: {
  draft: WhisperAsrDraft;
  saved?: WhisperAsrView & { id: string };
  active: boolean;
  onChange: (patch: Partial<WhisperAsrDraft>) => void;
}) {
  const { t } = useI18n();
  const [defaultBaseUrl, setDefaultBaseUrl] = useState('');
  const [defaultsFailed, setDefaultsFailed] = useState(false);
  const [editingKey, setEditingKey] = useState(false);
  useEffect(() => setEditingKey(false), [saved]);
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    setDefaultBaseUrl('');
    setDefaultsFailed(false);
    void voiceApi.speachesDefaults(abort.signal).then(
      ({ baseUrl }) => {
        if (!abort.signal.aborted) setDefaultBaseUrl(baseUrl);
      },
      () => {
        if (!abort.signal.aborted) setDefaultsFailed(true);
      },
    );
    return () => abort.abort();
  }, [active]);
  const baseUrl = draft.baseUrl ?? '';
  const canKeepKey = (() => {
    if (!saved?.hasApiKey) return false;
    if (!baseUrl.trim()) return !saved.baseUrl;
    try {
      return new URL(baseUrl.trim()).href.replace(/\/+$/, '') === saved.baseUrl;
    } catch {
      return false;
    }
  })();
  return (
    <>
      <label>
        API Base URL
        <input
          type="url"
          value={baseUrl}
          placeholder={
            defaultBaseUrl || t('console.voice.speachesDefaultAddress')
          }
          onChange={(e) => onChange({ baseUrl: e.target.value })}
        />
      </label>
      <p className="agent-hint">
        {defaultBaseUrl
          ? t('console.voice.speachesCurrentDefault', {
              address: defaultBaseUrl,
            })
          : t(
              defaultsFailed
                ? 'console.voice.speachesDefaultsFailed'
                : 'console.voice.speachesDefaultsLoading',
            )}
        <br />
        {t('console.asr.speachesAddressHint')}
      </p>
      <div className="voice-key-field">
        <span className="voice-key-label">
          {t('console.voice.optionalApiKey')}
        </span>
        {canKeepKey && !editingKey ? (
          <div className="voice-key-saved">
            <span role="status">{t('console.voice.keyConfiguredStatus')}</span>
            <button type="button" onClick={() => setEditingKey(true)}>
              {t('console.voice.changeKey')}
            </button>
          </div>
        ) : (
          <div className="voice-key-input">
            <input
              aria-label="API Key"
              type="password"
              autoComplete="new-password"
              value={draft.apiKey ?? ''}
              placeholder={t(
                canKeepKey
                  ? 'console.voice.keyPlaceholderNew'
                  : 'console.voice.keyPlaceholderEmpty',
              )}
              onChange={(e) => onChange({ apiKey: e.target.value })}
            />
            {canKeepKey && (
              <button
                type="button"
                onClick={() => {
                  onChange({ apiKey: '' });
                  setEditingKey(false);
                }}
              >
                {t('console.voice.cancelChangeKey')}
              </button>
            )}
          </div>
        )}
        <small>
          {t(
            canKeepKey
              ? editingKey
                ? 'console.voice.keyLeaveBlankHint'
                : 'console.voice.keySavedServerSide'
              : saved?.hasApiKey
                ? 'console.voice.keyChangedWarning'
                : 'console.voice.keyServerOnly',
          )}
        </small>
      </div>
      <SpeachesModelSelect
        baseUrl={baseUrl}
        apiKey={draft.apiKey ?? ''}
        serviceId={saved?.id}
        model={draft.model}
        voice=""
        active={active}
        mode="asr"
        loadModels={voiceApi.listSpeachesModels}
        onChange={({ model }) => onChange({ model })}
      />
    </>
  );
}
