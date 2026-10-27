import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import {
  SpatialTranscriber,
  SpatialVoice,
  type SpatialStatus,
  type TranscriptionState,
} from '../../audio';
import type { SpeechAnchor } from '../../graphics/speech-anchor';
import { useI18n } from '../../i18n';
import type { Connection } from '../../network/connection';
import { SpeechCaption } from './SpeechCaption';
import { useAsrSelection } from './asr-selection';

export function SpatialVoicePanel({
  connection,
  speechAnchor,
}: {
  connection: Connection;
  speechAnchor: (actor: string) => SpeechAnchor | null;
}) {
  const { t } = useI18n();
  const asr = useAsrSelection('spatial');
  const selectedAsr = useRef(asr.selected);
  selectedAsr.current = asr.selected;
  const [state, setState] = useState<SpatialStatus>({
    sending: false,
    listening: false,
    pending: false,
    connected: 0,
    error: '',
  });
  const [transcript, setTranscript] = useState<TranscriptionState>({
    status: t('voice.autoTranscribe'),
    text: '',
    partial: '',
    error: '',
  });
  const engine = useRef<SpatialVoice | null>(null);
  useEffect(() => {
    const voice = new SpatialVoice(connection, setState);
    const transcriber = new SpatialTranscriber(
      () => connection.chatToken,
      setTranscript,
    );
    voice.onMicrophone = (stream) => {
      if (stream) {
        if (selectedAsr.current.id)
          void transcriber.start(stream, selectedAsr.current);
        else
          setTranscript((previous) => ({
            ...previous,
            error: '请先在控制台为附近麦克风选择识别服务；语音通话仍可使用。',
          }));
      } else transcriber.stop();
    };
    engine.current = voice;
    connection.onSpatialSignal = voice.signal;
    connection.onAgentSpeech = voice.agentSpeech.receive;
    connection.stopSpatialInput = voice.stopMic;
    const unload = () => voice.dispose();
    window.addEventListener('pagehide', unload);
    return () => {
      window.removeEventListener('pagehide', unload);
      connection.onSpatialSignal = () => {};
      connection.onAgentSpeech = () => {};
      connection.stopSpatialInput = () => {};
      voice.dispose();
      transcriber.stop();
      engine.current = null;
    };
  }, [connection]);
  useEffect(() => {
    engine.current?.update();
  }, [connection.players, connection.status]);

  const micDisabled =
    connection.status !== 'connected' || connection.chatRecording;
  const listenDisabled = connection.status !== 'connected';
  const toggleMic = () => {
    if (micDisabled) return;
    if (state.sending || state.pending) engine.current?.stopMic();
    else void engine.current?.startMic();
  };
  const toggleListen = () => {
    if (listenDisabled) return;
    void engine.current?.setListening(!state.listening);
  };

  // 快捷键：V = 麦克风，L = 收听；游戏中无需松开鼠标即可开关语音。
  // 输入框聚焦/修饰键组合/按键重复时不触发，避免与聊天、WASD 冲突。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      )
        return;
      if (event.code === 'KeyV') {
        event.preventDefault();
        toggleMic();
      } else if (event.code === 'KeyL') {
        event.preventDefault();
        toggleListen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const micLabel = state.pending
    ? t('voice.micCancelPending')
    : state.sending
      ? t('voice.micTurnOff')
      : t('voice.micTurnOn');
  const listenLabel = state.listening
    ? t('voice.listenOff')
    : t('voice.listenOn');
  return (
    <>
      <SpeechCaption speech={state.agentSpeaking} anchor={speechAnchor} />
      <section
        className="spatial-voice"
        aria-label={t('voice.spatialAria')}
        data-hud
      >
        {(transcript.partial || transcript.text) && (
          <div className="spatial-live-caption" role="status">
            {transcript.partial ? (
              <span>
                {t('voice.interimCaption', { text: transcript.partial })}
              </span>
            ) : (
              <span>{transcript.text}</span>
            )}
          </div>
        )}
        {(state.error || transcript.error) && (
          <p role="alert" className="spatial-error-summary">
            {state.error || transcript.error}
          </p>
        )}
        <div className="spatial-toolbar">
          <button
            aria-label={micLabel}
            title={micLabel + ' (V)'}
            aria-pressed={state.sending}
            className={
              state.sending ? 'mic-live' : state.pending ? 'mic-pending' : ''
            }
            disabled={micDisabled}
            onClick={toggleMic}
          >
            {state.sending ? <Mic size={16} /> : <MicOff size={16} />}
          </button>
          <button
            aria-label={listenLabel}
            title={listenLabel + ' (L)'}
            aria-pressed={state.listening}
            disabled={listenDisabled}
            onClick={toggleListen}
          >
            {state.listening ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
        </div>
      </section>
    </>
  );
}
