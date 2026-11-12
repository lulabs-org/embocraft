import { useEffect, useState } from 'react';
import {
  DEFAULT_SENSE_VOICE_ASR,
  type SenseVoiceAsrDraft,
  type SenseVoiceAsrView,
} from '@voxel/shared';
import { useI18n } from '../../i18n';
import { voiceApi } from './api';

/**
 * 外部 SenseVoice 服务配置：地址、可选密钥、模型与语言分开保存。
 * 地址留空时跟随 SENSE_VOICE_API_URL，便于 Compose 内统一部署、控制台仍可覆盖。
 */
export function SenseVoiceAsrConfig({
  draft,
  saved,
  active,
  onChange,
}: {
  draft: SenseVoiceAsrDraft;
  saved?: SenseVoiceAsrView & { id: string };
  active: boolean;
  onChange: (patch: Partial<SenseVoiceAsrDraft>) => void;
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
    void voiceApi.asrDefaults(abort.signal).then(
      ({ senseVoiceBaseUrl }) => {
        if (!abort.signal.aborted) setDefaultBaseUrl(senseVoiceBaseUrl);
      },
      () => {
        if (!abort.signal.aborted) setDefaultsFailed(true);
      },
    );
    return () => abort.abort();
  }, [active]);
  const baseUrl = draft.baseUrl ?? '';
  // 仅当地址未变化时才允许沿用旧密钥，避免把密钥发往另一个服务。
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
            defaultBaseUrl || t('console.asr.senseVoiceAddressPlaceholder')
          }
          onChange={(e) => onChange({ baseUrl: e.target.value })}
        />
      </label>
      <p className="agent-hint">
        {defaultBaseUrl
          ? t('console.asr.senseVoiceCurrentDefault', {
              address: defaultBaseUrl,
            })
          : t(
              defaultsFailed
                ? 'console.asr.senseVoiceDefaultsFailed'
                : 'console.asr.senseVoiceDefaultsLoading',
            )}
        <br />
        {t('console.asr.senseVoiceAddressHint')}
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
      <label>
        {t('console.asr.recognitionModel')}
        <input
          value={draft.model}
          maxLength={200}
          placeholder={DEFAULT_SENSE_VOICE_ASR.model}
          onChange={(e) => onChange({ model: e.target.value })}
        />
      </label>
      <small>{t('console.asr.senseVoiceModelNote')}</small>
      <label>
        {t('console.asr.primaryLanguage')}
        <select
          value={draft.language}
          onChange={(e) =>
            onChange({
              language: e.target.value as SenseVoiceAsrDraft['language'],
            })
          }
        >
          <option value="auto">
            {t('console.asr.senseVoiceLanguageAuto')}
          </option>
          <option value="zh">{t('console.asr.senseVoiceLanguageZh')}</option>
          <option value="en">{t('console.asr.senseVoiceLanguageEn')}</option>
        </select>
      </label>
      <small>{t('console.asr.senseVoiceServerNote')}</small>
    </>
  );
}
