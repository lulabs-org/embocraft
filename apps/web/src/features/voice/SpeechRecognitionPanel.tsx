import { ConsoleFeedbackRelay } from '../../components/ui/ConsoleFeedbackRelay';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BailianSpeechSession,
  BrowserRecognitionSession,
  LiveRecorder,
  LiveSpeechSession,
  speechTransport,
} from '../../audio';
import { useI18n } from '../../i18n/context';
import type { Connection } from '../../network/connection';
import { voiceApi, type SpeechCapabilities } from './api';
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
  const [partial, setPartial] = useState('');
  const [capabilities, setCapabilities] = useState<SpeechCapabilities>();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [retry, setRetry] = useState(0);
  const [serverLanguage, setServerLanguage] = useState('zh-CN');
  const language =
    asr.draft.provider === 'browser' ? asr.draft.language : serverLanguage;
  const [state, setState] = useState<'idle' | 'listening' | 'thinking'>('idle');
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const resultText = [text, partial]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
  const resultRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const result = resultRef.current;
    if (result) result.scrollLeft = result.scrollWidth;
  }, [resultText]);
  const ownsMicrophone = useRef(false);
  const release = useCallback(() => {
    if (ownsMicrophone.current) connection.voiceLabRecording = false;
    ownsMicrophone.current = false;
  }, [connection]);
  const stop = () => {
    live.cancel();
    browser.cancel();
    setPartial('');
    release();
    setState('idle');
  };
  useEffect(() => {
    setState('idle');
    return () => {
      live.cancel();
      browser.cancel();
      setPartial('');
      release();
    };
  }, [active, connection, live, browser, service, release]);
  useEffect(() => {
    if (!active || !isWhisper) return;
    const abort = new AbortController();
    setChecking(true);
    setCheckError('');
    setCapabilities(undefined);
    const timeout = setTimeout(() => {
      abort.abort();
      setChecking(false);
      setCheckError(t('console.asr.serviceFailed'));
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
    setText('');
  };
  const start = () => {
    if (!ready || busy) return;
    setError('');
    if (connection.chatRecording || connection.voiceLabRecording) {
      setError(t('console.asr.browserCannotRecordError'));
      return;
    }
    connection.stopSpatialInput();
    connection.voiceLabRecording = true;
    ownsMicrophone.current = true;
    setText('');
    const callbacks = {
      onState: (next: 'listening' | 'thinking') => {
        setState(next);
      },
      onError: (message: string) => {
        release();
        setState('idle');
        setError(message);
      },
    };
    if (isBrowser) {
      setState('listening');
      browser.start(language, {
        onStatus: () => {},
        onPartial: setPartial,
        onFinal: (value) => {
          setPartial('');
          setText((previous) => (previous + '\n' + value).trim().slice(-4000));
        },
        onError: callbacks.onError,
        onEnd: () => {
          release();
          setState('idle');
        },
      });
    } else
      void live.start(
        language,
        {
          onState: callbacks.onState,
          onStatus: () => {},
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
                      : `${value.provider === 'openai' ? 'OpenAI' : value.provider === 'gemini' ? 'Gemini' : t('console.asr.typeBailian')} · ${value.model}`,
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
          <BailianAsrConfig manager={asr} disabled={busy}>
            {!isBrowser && asr.selected?.provider === 'whisper' && (
              <section className="console-panel-section asr-service-status">
                <div className="asr-service-status-row">
                  <h4>{t('console.asr.whisperStatusHeading')}</h4>
                  <span role="status" aria-live="polite">
                    {checking
                      ? t('console.asr.checkingService')
                      : checkError
                        ? t('console.asr.serviceFailed')
                        : capabilities?.local.available
                          ? t('console.asr.serviceReady')
                          : t('console.asr.serviceNotReady')}
                  </span>
                  <button
                    type="button"
                    disabled={checking || busy}
                    onClick={() => {
                      setChecking(true);
                      setRetry((value) => value + 1);
                    }}
                  >
                    {t('console.asr.recheck')}
                  </button>
                </div>
                {capabilities && !capabilities.local.available && (
                  <p className="agent-hint">{capabilities.local.reason}</p>
                )}
              </section>
            )}
            <section
              className="voice-preview asr-preview"
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
              <div className="asr-preview-row">
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
                </div>
                <textarea
                  ref={resultRef}
                  rows={1}
                  readOnly
                  aria-label={t('console.asr.confirmedTextLabel')}
                  aria-live="polite"
                  value={resultText}
                  placeholder={t(
                    state === 'listening'
                      ? 'console.asr.listeningInterim'
                      : 'console.asr.confirmedTextPlaceholder',
                  )}
                />
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
              <ConsoleFeedbackRelay error={error} active={active} />
            </section>
          </BailianAsrConfig>
        </div>
      </div>
    </section>
  );
}
