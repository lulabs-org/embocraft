import type { SpeachesModel, SpeachesConnectionDraft } from '@voxel/shared';
import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/context';

export function SpeachesModelSelect({
  baseUrl,
  apiKey,
  serviceId,
  model,
  voice,
  active,
  onChange,
  mode = 'tts',
  loadModels,
}: {
  baseUrl: string;
  apiKey: string;
  serviceId?: string;
  model: string;
  voice: string;
  active: boolean;
  onChange: (selection: { model: string; voice: string }) => void;
  mode?: 'tts' | 'asr';
  loadModels: (
    connection: SpeachesConnectionDraft,
    signal?: AbortSignal,
  ) => Promise<{ models: SpeachesModel[] }>;
}) {
  const { t } = useI18n();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    baseUrl: string;
    apiKey: string;
    serviceId?: string;
    revision: number;
    models: SpeachesModel[];
    error: string;
  }>();
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    setResult(undefined);
    // Editing an address or key must not send one request per keystroke.
    const timer = window.setTimeout(() => {
      void loadModels({ baseUrl, apiKey, serviceId }, abort.signal).then(
        ({ models }) => {
          if (!abort.signal.aborted)
            setResult({
              baseUrl,
              apiKey,
              serviceId,
              revision,
              models,
              error: '',
            });
        },
        (error: unknown) => {
          if (!abort.signal.aborted)
            setResult({
              baseUrl,
              apiKey,
              serviceId,
              revision,
              models: [],
              error:
                error instanceof Error
                  ? error.message
                  : t('console.voice.modelsFailed'),
            });
        },
      );
    }, 350);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [active, baseUrl, apiKey, serviceId, revision, t, loadModels]);

  // Never show results from a previous connection, even before its effect cleanup.
  const current =
    result?.baseUrl === baseUrl &&
    result.apiKey === apiKey &&
    result.serviceId === serviceId &&
    result.revision === revision
      ? result
      : undefined;
  const loading = !current;
  const models = current?.models ?? [];
  const selected = models.find((item) => item.id === model);
  const voices = selected?.voices ?? [];
  return (
    <>
      <div className="voice-select-field">
        <label>
          {t(
            mode === 'asr'
              ? 'console.asr.recognitionModel'
              : 'console.voice.voiceModel',
          )}
          <select
            required
            value={model}
            disabled={loading || !!current?.error}
            onChange={(e) => {
              const next = models.find((item) => item.id === e.target.value);
              if (next)
                onChange({
                  model: next.id,
                  voice: next.voices.length === 1 ? next.voices[0].id : '',
                });
            }}
          >
            <option value="">{t('console.voice.chooseModel')}</option>
            {model && !selected && (
              <option value={model} disabled>
                {model} ·{' '}
                {t(
                  loading || current?.error
                    ? 'console.voice.savedSelection'
                    : 'console.voice.modelUnavailable',
                )}
              </option>
            )}
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
                {mode === 'tts' && item.languages.length
                  ? ` · ${item.languages.join(', ')}`
                  : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!active || loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          {t('console.voice.refreshModels')}
        </button>
      </div>
      {loading && (
        <small role="status">
          {t(
            mode === 'asr'
              ? 'console.asr.modelsLoading'
              : 'console.voice.modelsLoading',
          )}
        </small>
      )}
      {current?.error && <small role="alert">{current.error}</small>}
      {current && !current.error && !models.length && (
        <small role="status">
          {t(
            mode === 'asr'
              ? 'console.asr.modelsEmpty'
              : 'console.voice.modelsEmpty',
          )}
        </small>
      )}
      {current && !current.error && model && !selected && (
        <small role="alert">{t('console.voice.modelMissingHint')}</small>
      )}
      {mode === 'tts' && (
        <label>
          {t('console.voice.voiceLabel')}
          {voices.length ? (
            <select
              required
              value={voice}
              onChange={(e) => onChange({ model, voice: e.target.value })}
            >
              <option value="">{t('console.voice.chooseVoice')}</option>
              {voice && !voices.some((item) => item.id === voice) && (
                <option value={voice} disabled>
                  {voice} · {t('console.voice.modelUnavailable')}
                </option>
              )}
              {voices.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.language ? ` · ${item.language}` : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              required
              maxLength={200}
              value={voice}
              disabled={!selected}
              placeholder={t('console.voice.voicePlaceholder')}
              onChange={(e) => onChange({ model, voice: e.target.value })}
            />
          )}
        </label>
      )}
      {mode === 'tts' && selected && !voices.length && (
        <small>{t('console.voice.manualVoiceHint')}</small>
      )}
    </>
  );
}
