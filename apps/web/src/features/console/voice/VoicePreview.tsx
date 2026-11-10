import { ConsoleFeedbackRelay } from '../../../components/ui/ConsoleFeedbackRelay';
import type { VoiceServiceDraft } from '@voxel/shared';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { speakBrowserText } from '../../../audio';
import { useI18n } from '../../../i18n';
import { voiceApi } from './api';
import { voicePreviewSamples } from './voice-preview-samples';

/** Previews the current form values, including changes that are not saved yet. */
export function VoicePreview({
  serviceId,
  draft,
  active,
  disabled = false,
}: {
  serviceId?: string;
  draft: VoiceServiceDraft;
  active: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const textId = useId();
  const [text, setText] = useState(voicePreviewSamples[0].text);
  const [language, setLanguage] = useState(voicePreviewSamples[0].language);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const request = useRef<AbortController | undefined>(undefined);
  const audio = useRef<HTMLAudioElement>(null);
  // Any configuration change invalidates the audio and status of an older setup.
  const signature = [
    draft.type,
    draft.baseUrl,
    draft.model,
    draft.voice,
    draft.voiceLanguage ?? '',
    draft.speed,
  ].join('\u0000');
  // Server types need a model and a voice; browser synthesis can fall back to a system voice.
  const ready =
    draft.type === 'browser' || (!!draft.model.trim() && !!draft.voice.trim());
  const stop = useCallback(() => {
    request.current?.abort();
    audio.current?.pause();
    setUrl('');
    setBusy(false);
    setStatus('');
    setError('');
  }, []);
  useEffect(() => {
    stop();
    const player = audio.current;
    return () => {
      request.current?.abort();
      player?.pause();
    };
  }, [serviceId, active, disabled, signature, stop]);
  useEffect(() => {
    if (!url) return;
    void audio.current
      ?.play()
      .catch(() => setStatus(t('console.voice.previewStatusClickToPlay')));
    return () => URL.revokeObjectURL(url);
  }, [url, t]);
  /** Browser services speak locally; every other type is synthesized by the server. */
  const preview = async () => {
    if (disabled || !active || !ready) return;
    stop();
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setStatus(t('console.voice.previewStatusConnecting'));
    try {
      if (draft.type === 'browser') {
        setStatus(t('console.voice.previewStatusBrowserSpeaking'));
        await speakBrowserText(text, draft, abort.signal);
        if (!abort.signal.aborted)
          setStatus(t('console.voice.previewStatusBrowserDone'));
        return;
      }
      const blob = await voiceApi.previewVoice(
        { serviceId, draft, text },
        abort.signal,
      );
      if (abort.signal.aborted) return;
      setUrl(URL.createObjectURL(blob));
      setStatus(t('console.voice.previewStatusSuccess'));
    } catch (error) {
      if (!abort.signal.aborted) {
        setStatus('');
        setError(
          error instanceof Error
            ? error.message
            : t('console.voice.previewStatusFailed'),
        );
      }
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  return (
    <section
      className="voice-preview tts-preview"
      aria-label={t('console.voice.previewSectionAria')}
    >
      <div className="tts-preview-heading">
        <label htmlFor={textId}>{t('console.voice.previewTextLabel')}</label>
        <select
          className="tts-preview-language"
          aria-label={t('console.voice.previewLangAria')}
          title={t('console.voice.previewLangTitle')}
          value={language}
          onChange={(event) => {
            const sample = voicePreviewSamples.find(
              (item) => item.language === event.target.value,
            );
            if (!sample) return;
            stop();
            setLanguage(sample.language);
            setText(sample.text);
          }}
        >
          {language === 'custom' && (
            <option value="custom">{t('console.voice.customText')}</option>
          )}
          {voicePreviewSamples.map((sample) => (
            <option key={sample.language} value={sample.language}>
              {sample.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!busy && (!ready || disabled || !active || !text.trim())}
          onClick={() => (busy ? stop() : void preview())}
          title={
            busy
              ? t('console.voice.previewCancelTitle')
              : t('console.voice.previewStartTitle')
          }
        >
          {busy
            ? t('console.voice.stopPreview')
            : url
              ? t('console.voice.rePreview')
              : t('console.voice.startPreview')}
        </button>
      </div>
      <textarea
        id={textId}
        rows={2}
        maxLength={240}
        value={text}
        lang={language === 'custom' ? undefined : language}
        dir="auto"
        onChange={(e) => {
          stop();
          setText(e.target.value);
          setLanguage('custom');
        }}
      />
      <small className="tts-preview-hint">
        {draft.type === 'browser'
          ? t('console.voice.previewHintBrowser')
          : draft.type === 'speaches'
            ? t('console.voice.previewHintSpeaches')
            : t('console.voice.previewHintCloud')}
      </small>
      {status && (
        <p className="tts-preview-status" role="status">
          {status}
        </p>
      )}
      <ConsoleFeedbackRelay error={error} active={active} />
      <audio
        ref={audio}
        controls
        hidden={!url}
        src={url || undefined}
        aria-label={t('console.voice.previewAudioAria')}
        onError={() => setError(t('console.voice.previewStatusPlayFailed'))}
      />
    </section>
  );
}
