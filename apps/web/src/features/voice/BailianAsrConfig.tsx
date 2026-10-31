import { useEffect, useState } from 'react';
import type { BailianAsrDraft } from '@voxel/shared';
import { useI18n } from '../../i18n/context';
import type { AsrProvider } from './browser-asr-services';
import { SpeachesAsrConfig } from './SpeachesAsrConfig';
import { browserLanguages } from './browser-asr-languages';
import type { useAsrServices } from './useAsrServices';

export function BailianAsrConfig({
  manager,
  disabled,
}: {
  manager: ReturnType<typeof useAsrServices>;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const {
    draft,
    selected: saved,
    dirty,
    saving: busy,
    change,
    save,
    remove,
    reload,
  } = manager;
  const [editingKey, setEditingKey] = useState(false);
  useEffect(() => setEditingKey(false), [saved]);
  const hasSavedKey =
    saved?.provider !== 'whisper' &&
    saved?.provider !== 'browser' &&
    !!saved?.hasApiKey;
  const canKeepKey =
    hasSavedKey &&
    draft.provider !== 'whisper' &&
    draft.provider !== 'browser' &&
    saved?.region === draft.region &&
    saved?.workspaceId === draft.workspaceId;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="console-panel-heading">
        <h3>
          {saved ? t('console.asr.headingEdit') : t('console.asr.headingAdd')}
        </h3>
        <p>{t('console.asr.headingDesc')}</p>
      </div>
      <fieldset disabled={busy || disabled}>
        <label>
          {t('console.asr.serviceName')}
          <input
            required
            maxLength={50}
            value={draft.name}
            onChange={(e) => change({ name: e.target.value })}
          />
        </label>
        <label>
          {t('console.asr.serviceType')}
          <select
            value={draft.provider ?? 'bailian'}
            disabled={!!saved}
            onChange={(e) =>
              manager.changeProvider(e.target.value as AsrProvider)
            }
          >
            <option value="whisper">{t('console.asr.typeWhisper')}</option>
            <option value="bailian">{t('console.asr.typeBailian')}</option>
            <option value="browser">{t('console.asr.typeBrowser')}</option>
          </select>
        </label>
        {draft.provider === 'browser' ? (
          <>
            <label>
              {t('console.asr.primaryLanguage')}
              <select
                value={draft.language}
                onChange={(e) => change({ language: e.target.value })}
              >
                {browserLanguages.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <small>{t('console.asr.browserNote')}</small>
          </>
        ) : draft.provider === 'whisper' ? (
          <>
            <SpeachesAsrConfig
              draft={draft}
              saved={saved?.provider === 'whisper' ? saved : undefined}
              active={manager.active}
              onChange={change}
            />
            <label>
              {t('console.asr.temperatureLabel')}
              <input
                type="number"
                min={0}
                max={1}
                step={0.1}
                required
                value={draft.temperature}
                onChange={(e) =>
                  change({ temperature: e.target.valueAsNumber })
                }
              />
            </label>
            <small>{t('console.asr.whisperRecognitionNote')}</small>
            <label>
              {t('console.asr.promptLabel')}
              <textarea
                maxLength={500}
                rows={2}
                value={draft.prompt}
                placeholder={t('console.asr.promptPlaceholder')}
                onChange={(e) => change({ prompt: e.target.value })}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              {t('console.asr.regionLabel')}
              <select
                value={draft.region}
                onChange={(e) =>
                  change({
                    region: e.target.value as BailianAsrDraft['region'],
                  })
                }
              >
                <option value="beijing">
                  {t('console.asr.regionBeijing')}
                </option>
                <option value="singapore">
                  {t('console.asr.regionSingapore')}
                </option>
              </select>
            </label>
            <label>
              {t('console.asr.workspaceIdLabel')}
              <input
                value={draft.workspaceId}
                maxLength={80}
                placeholder={t('console.asr.workspaceIdPlaceholder')}
                onChange={(e) => change({ workspaceId: e.target.value })}
              />
            </label>
            <label>
              {t('console.asr.recognitionModel')}
              <select
                value={draft.model}
                onChange={(e) =>
                  change({ model: e.target.value as BailianAsrDraft['model'] })
                }
              >
                <option value="fun-asr-realtime">Fun-ASR Realtime</option>
                <option value="paraformer-realtime-v2">
                  Paraformer Realtime v2
                </option>
              </select>
            </label>
            <div className="voice-key-field">
              <span className="voice-key-label">API Key</span>
              {canKeepKey && !editingKey ? (
                <div className="voice-key-saved">
                  <span role="status">
                    {t('console.voice.keyConfiguredStatus')}
                  </span>
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
                    value={draft.apiKey}
                    placeholder={
                      canKeepKey
                        ? t('console.voice.keyPlaceholderNew')
                        : t('console.voice.keyPlaceholderEmpty')
                    }
                    onChange={(e) => change({ apiKey: e.target.value })}
                  />
                  {canKeepKey && (
                    <button
                      type="button"
                      onClick={() => {
                        if (draft.apiKey) change({ apiKey: '' });
                        setEditingKey(false);
                      }}
                    >
                      {t('console.voice.cancelChangeKey')}
                    </button>
                  )}
                </div>
              )}
              <small>
                {canKeepKey
                  ? editingKey
                    ? t('console.voice.keyLeaveBlankHint')
                    : t('console.voice.keySavedServerSide')
                  : hasSavedKey
                    ? t('console.voice.keyChangedWarning')
                    : t('console.voice.keyServerOnly')}
              </small>
            </div>
          </>
        )}
        <div className="voice-service-actions console-form-actions">
          <button
            className="primary"
            type="submit"
            disabled={
              !dirty ||
              manager.loading ||
              (draft.provider === 'whisper' && !draft.model)
            }
          >
            {busy ? t('common.loading') : t('console.asr.saveServiceButton')}
          </button>
          {saved && (
            <button type="button" onClick={() => void remove()}>
              {t('console.asr.deleteServiceButton')}
            </button>
          )}
          <button type="button" onClick={reload}>
            {t('console.asr.reloadButton')}
          </button>
        </div>
      </fieldset>
      {dirty && (
        <p className="agent-hint">{t('console.asr.dirtyRecordHint')}</p>
      )}
      {draft.provider === 'browser' ? (
        <p className="agent-hint">{t('console.asr.browserHint')}</p>
      ) : draft.provider === 'whisper' ? (
        <p className="agent-hint">{t('console.asr.whisperHint')}</p>
      ) : (
        <a
          className="console-help-link"
          href="https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide"
          target="_blank"
          rel="noreferrer"
        >
          {t('console.asr.aliyunDocs')}
        </a>
      )}
    </form>
  );
}
