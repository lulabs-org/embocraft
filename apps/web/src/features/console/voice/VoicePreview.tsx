import { ConsoleFeedbackRelay } from '../../../components/ui/ConsoleFeedbackRelay';
import type { VoiceServiceView } from '@voxel/shared';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { speakBrowserText } from '../../../audio';
import { useI18n } from '../../../i18n';
import { voiceApi } from './api';
import { voicePreviewSamples } from './voice-preview-samples';

export function VoicePreview({
  serviceId,
  service,
  active,
  disabled = false,
}: {
  serviceId?: string;
  service?: VoiceServiceView;
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
  }, [serviceId, active, disabled, stop]);
  useEffect(() => {
    if (!url) return;
    void audio.current
      ?.play()
      .catch(() => setStatus(t('console.voice.previewStatusClickToPlay')));
    return () => URL.revokeObjectURL(url);
  }, [url, t]);
  const preview = async () => {
    if (!serviceId || disabled || !active) return;
    stop();
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setStatus(t('console.voice.previewStatusConnecting'));
    try {
      if (service?.type === 'browser') {
        setStatus(t('console.voice.previewStatusBrowserSpeaking'));
        await speakBrowserText(text, service, abort.signal);
        if (!abort.signal.aborted)
          setStatus(t('console.voice.previewStatusBrowserDone'));
        return;
      }
      const blob = await voiceApi.previewVoice(serviceId, text, abort.signal);
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
          disabled={
            !busy && (!serviceId || disabled || !active || !text.trim())
          }
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
        {service?.type === 'browser'
          ? t('console.voice.previewHintBrowser')
          : service?.type === 'speaches'
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
