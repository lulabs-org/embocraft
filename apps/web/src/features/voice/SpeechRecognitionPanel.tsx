import { ConsoleFeedbackRelay } from '../../components/ui/ConsoleFeedbackRelay';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  BailianSpeechSession,
  BrowserRecognitionSession,
  LiveRecorder,
  LiveSpeechSession,
  LocalRecorder,
  speechTransport,
  type SpeechCapabilities,
} from '../../audio';
import { useI18n } from '../../i18n/context';
import type { Connection } from '../../network/connection';
import { voiceApi } from './api';
import { BailianAsrConfig } from './BailianAsrConfig';
import { browserLanguages } from './browser-asr-languages';
import { useAsrServices } from './useAsrServices';

export function SpeechRecognitionPanel({
  active,
  connection,
}: {
  active: boolean;
  connection: Connection;
}) {
  const { t } = useI18n();
  const serverLanguages = [
    ['zh-CN', t('console.asr.langChinese')],
    ['en-US', t('console.asr.langEnglish')],
  ] as const;

  const [recorder] = useState(() => new LocalRecorder());
  const [live] = useState(() => new LiveRecorder());
  const [browser] = useState(() => new BrowserRecognitionSession());
  const asr = useAsrServices(active);
  const service = asr.id;
  const isBrowser = asr.draft.provider === 'browser';
  const isWhisper = asr.draft.provider === 'whisper';
  const whisperServiceId =
    asr.selected?.provider === 'whisper' ? service : undefined;
  const selectedModel =
    asr.selected && asr.selected.provider !== 'browser'
      ? asr.selected.model
      : undefined;
  const fileTestId = useId();
  const [showFileTest, setShowFileTest] = useState(false);
  const [partial, setPartial] = useState('');
  const [capabilities, setCapabilities] = useState<SpeechCapabilities>();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [checkedAt, setCheckedAt] = useState<Date>();
  const [retry, setRetry] = useState(0);
  const [serverLanguage, setServerLanguage] = useState('zh-CN');
  const language =
    asr.draft.provider === 'browser' ? asr.draft.language : serverLanguage;
  const [state, setState] = useState<'idle' | 'listening' | 'thinking'>('idle');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const ownsMicrophone = useRef(false);
  const release = useCallback(() => {
    if (ownsMicrophone.current) connection.voiceLabRecording = false;
    ownsMicrophone.current = false;
  }, [connection]);
  const stop = () => {
    recorder.cancel();
    live.cancel();
    browser.cancel();
    setPartial('');
    release();
    setState('idle');
    setStatus('');
  };
  useEffect(() => {
    setShowFileTest(false);
    setState('idle');
    setStatus('');
    return () => {
      recorder.cancel();
      live.cancel();
      browser.cancel();
      setPartial('');
      release();
    };
  }, [active, connection, recorder, live, browser, service, release]);
  useEffect(() => {
    if (!active || !isWhisper) return;
    const abort = new AbortController();
    setChecking(true);
    setCheckError('');
    setCheckedAt(undefined);
    setCapabilities(undefined);
    const timeout = setTimeout(() => {
      abort.abort();
      setChecking(false);
      setCheckError(t('console.asr.serviceFailed'));
      setCheckedAt(new Date());
    }, 10000);
    void voiceApi
      .capabilities(abort.signal, whisperServiceId)
      .then((value) => {
        if (!abort.signal.aborted) setCapabilities(value);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setCheckError(t('console.asr.serviceFailed'));
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!abort.signal.aborted) {
          setChecking(false);
          setCheckedAt(new Date());
        }
      });
    return () => {
      clearTimeout(timeout);
      abort.abort();
    };
  }, [
    active,
    isWhisper,
    retry,
    whisperServiceId,
    selectedModel,
    asr.selected,
    t,
  ]);
  const busy = state !== 'idle';
  const ready =
    active &&
    !!asr.selected &&
    !asr.dirty &&
    !asr.saving &&
    (isBrowser
      ? browser.available
      : asr.loaded &&
        !asr.loading &&
        (asr.selected.provider === 'whisper'
          ? capabilities?.local.available && !checking && !checkError
          : asr.selected.provider !== 'browser' && asr.selected.hasApiKey));
  const chooseService = (id: string) => {
    if (id === service) return;
    stop();
    asr.choose(id);
    setError('');
    setStatus('');
    setText('');
  };
  const start = (file?: File) => {
    if (!ready || busy) return;
    setError('');
    if (!file) {
      if (connection.chatRecording || connection.voiceLabRecording) {
        setError(t('console.asr.browserCannotRecordError'));
        return;
      }
      connection.stopSpatialInput();
      connection.voiceLabRecording = true;
      ownsMicrophone.current = true;
    }
    setText('');
    const callbacks = {
      onState: (next: 'listening' | 'thinking', message: string) => {
        setState(next);
        setStatus(message);
      },
      onText: (value: string) => {
        release();
        setText(value);
        setState('idle');
        setStatus(t('console.asr.checkFinished'));
      },
      onError: (message: string) => {
        release();
        setState('idle');
        setStatus('');
        setError(message);
      },
    };
    if (isBrowser) {
      setState('listening');
      browser.start(language, {
        onStatus: setStatus,
        onPartial: setPartial,
        onFinal: (value) => {
          setPartial('');
          setText((previous) => (previous + '\n' + value).trim().slice(-4000));
        },
        onError: callbacks.onError,
        onEnd: () => {
          release();
          setState('idle');
          setStatus(t('console.asr.checkFinished'));
        },
      });
    } else if (file)
      void recorder.transcribeFile(file, language, callbacks, whisperServiceId);
    else
      void live.start(
        language,
        {
          onState: callbacks.onState,
          onStatus: setStatus,
          onPartial: setPartial,
          onFinal: (value) => {
            setPartial('');
            setText((previous) =>
              (previous + '\n' + value).trim().slice(-4000),
            );
          },
          onError: callbacks.onError,
          onEnd: () => {
            release();
            setState('idle');
            setStatus(t('console.asr.checkFinished'));
          },
        },
        undefined,
        undefined,
        !isWhisper
          ? (events) => new BailianSpeechSession(service, language, events)
          : whisperServiceId
            ? (events) =>
                new LiveSpeechSession(
                  speechTransport(
                    language,
                    undefined,
                    undefined,
                    whisperServiceId,
                  ),
                  events,
                )
            : undefined,
      );
  };
  return (
    <section aria-label={t('console.asr.panelAria')}>
      <div className="voice-services-layout console-columns">
        <aside
          className="console-sidebar"
          aria-label={t('console.asr.listAria')}
        >
          <button
            className="primary console-sidebar-add"
            type="button"
            aria-pressed={service === 'new'}
            disabled={busy || asr.saving || !asr.canAdd}
            onClick={() => chooseService('new')}
          >
            {t('console.asr.addService')}
          </button>
          {!asr.loading && asr.services.length === 0 && (
            <p className="agent-hint">{t('console.asr.noSavedServices')}</p>
          )}
          <div className="console-sidebar-items">
            {asr.services
              .map((value) => ({
                id: value.id,
                name: value.name,
                detail:
                  value.provider === 'browser'
                    ? `${t('console.asr.typeBrowser')} · ${browserLanguages.find(([code]) => code === value.language)?.[1] ?? value.language}`
                    : value.provider === 'whisper'
                      ? `Speaches · ${value.model}`
                      : `${t('console.asr.typeBailian')} · ${value.model}`,
              }))
              .map((item) => (
                <button
                  className="console-sidebar-item"
                  key={item.id}
                  type="button"
                  aria-pressed={service === item.id}
                  disabled={busy || asr.saving}
                  onClick={() => chooseService(item.id)}
                >
                  <span className="console-sidebar-copy">
                    <strong title={item.name}>{item.name}</strong>
                    <small title={item.detail}>{item.detail}</small>
                  </span>
                </button>
              ))}
          </div>
          {asr.loading && (
            <p className="agent-hint" role="status">
              {t('console.asr.loadingServices')}
            </p>
          )}
          <p className="console-sidebar-note">{t('console.asr.sidebarNote')}</p>
        </aside>
        <div className="agent-form console-panel">
          <ConsoleFeedbackRelay error={asr.error} active={active} />
          {asr.notice && (
            <p role="status" className="agent-notice">
              {asr.notice}
            </p>
          )}
          <BailianAsrConfig manager={asr} disabled={busy} />
          {!isBrowser && asr.selected?.provider === 'whisper' && (
            <section className="console-panel-section">
              <h4>{t('console.asr.whisperStatusHeading')}</h4>
              <p role="status" aria-live="polite" aria-atomic="true">
                {checking
                  ? t('console.asr.checkingService')
                  : checkError
                    ? t('console.asr.serviceFailed')
                    : capabilities?.local.available
                      ? t('console.asr.serviceReady')
                      : t('console.asr.serviceNotReady')}
                {!checking && checkedAt && (
                  <small className="asr-help">
                    {checkError
                      ? t('console.asr.serviceFailed')
                      : t('console.asr.checkFinished')}{' '}
                    · {checkedAt.toLocaleTimeString('zh-CN', { hour12: false })}
                  </small>
                )}
              </p>
              <ConsoleFeedbackRelay error={checkError} active={active} />
              {capabilities && (
                <p className="agent-hint">{capabilities.local.reason}</p>
              )}
              <div>
                <button
                  type="button"
                  disabled={checking || busy}
                  onClick={() => {
                    setChecking(true);
                    setRetry((value) => value + 1);
                  }}
                >
                  {checking ? t('common.loading') : t('console.asr.recheck')}
                </button>
              </div>
              <p className="agent-hint">{t('console.asr.whisperServerNote')}</p>
            </section>
          )}
          <section
            className="voice-preview"
            aria-label={t('console.asr.tryAsrHeading')}
          >
            <h4>{t('console.asr.tryAsrHeading')}</h4>
            {!isBrowser && (
              <label>
                {t('console.asr.primaryLanguage')}
                <select
                  value={language}
                  disabled={busy}
                  onChange={(event) => setServerLanguage(event.target.value)}
                >
                  {serverLanguages.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="voice-service-actions">
              <button
                type="button"
                disabled={
                  state === 'idle'
                    ? !ready || (!isBrowser && !live.canRecord)
                    : state === 'thinking'
                }
                onClick={() => {
                  if (state === 'idle') {
                    start();
                  } else if (state === 'listening') {
                    if (isBrowser) {
                      setState('thinking');
                      browser.finish();
                    } else void live.finish();
                  } else {
                    stop();
                  }
                }}
              >
                {state === 'idle'
                  ? t('console.asr.startRecording')
                  : state === 'listening'
                    ? t('console.asr.finishRecording')
                    : t('console.asr.recording')}
              </button>
              {!isBrowser && asr.selected?.provider === 'whisper' && (
                <button
                  type="button"
                  className="asr-file-toggle"
                  aria-expanded={showFileTest}
                  aria-controls={fileTestId}
                  disabled={busy}
                  onClick={() => setShowFileTest((value) => !value)}
                >
                  {showFileTest
                    ? t('console.asr.toggleFileTestHide')
                    : t('console.asr.toggleFileTestShow')}
                </button>
              )}
            </div>
            {isBrowser && !browser.available && (
              <p role="alert" className="agent-error">
                {t('console.asr.browserNotSupportedError')}
              </p>
            )}
            {!isBrowser && !live.canRecord && (
              <p className="agent-hint">
                {t('console.asr.browserCannotRecordError')}
              </p>
            )}
            {!isBrowser && asr.selected?.provider === 'whisper' && (
              <div
                id={fileTestId}
                hidden={!showFileTest}
                className="asr-file-test"
              >
                <label>
                  {t('console.asr.fileInputLabel')}
                  <input
                    type="file"
                    accept=".wav,.webm,.mp4,.m4a,.ogg"
                    disabled={!ready || busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) start(file);
                    }}
                  />
                </label>
              </div>
            )}
            {status && <p role="status">{status}</p>}
            <ConsoleFeedbackRelay error={error} active={active} />
            <label>
              {t('console.asr.confirmedTextLabel')}
              <textarea
                rows={4}
                readOnly
                aria-live="polite"
                value={
                  partial ? (text ? `${text}\n${partial}` : partial) : text
                }
                placeholder={t(
                  state === 'listening'
                    ? 'console.asr.listeningInterim'
                    : 'console.asr.confirmedTextPlaceholder',
                )}
              />
            </label>
          </section>
        </div>
      </div>
    </section>
  );
}
