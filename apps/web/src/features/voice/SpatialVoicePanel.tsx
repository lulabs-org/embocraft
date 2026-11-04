import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import { spatialMix, SPEECH_HEARING_THRESHOLD } from '@voxel/shared';
import {
  SpatialTranscriber,
  SpatialVoice,
  type SpatialStatus,
  type TranscriptionState,
} from '../../audio';
import type { SpeechAnchor } from '../../graphics/speech-anchor';
import { useI18n } from '../../i18n';
import type { Connection } from '../../network/connection';
import { voiceApi } from './api';
import {
  LiveAgentConversation,
  type LiveConversationState,
} from '../../audio/spatial/live-agent-conversation';
import { SpeechCaption } from './SpeechCaption';
import { useAsrSelection } from './asr-selection';
import { useSpatialVoiceMode } from './spatial-mode';

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
  const selectionStatus = useRef(asr);
  selectionStatus.current = asr;
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
  const live = useRef<LiveAgentConversation | null>(null);
  const transcriberRef = useRef<SpatialTranscriber | null>(null);
  const mode = useSpatialVoiceMode();
  const modeRef = useRef(mode);
  useLayoutEffect(() => {
    if (modeRef.current === mode) return;
    engine.current?.stopMic();
    modeRef.current = mode;
    setLiveState({ status: 'idle', error: '', humanText: '', agentText: '' });
  }, [mode]);
  const agentsRef = useRef<{ id: string; name: string }[]>([]);
  const [discoveryError, setDiscoveryError] = useState('');
  const [liveState, setLiveState] = useState<LiveConversationState>({
    status: 'idle',
    error: '',
    humanText: '',
    agentText: '',
  });
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (
      mode !== 'live' ||
      !state.sending ||
      connection.status !== 'connected' ||
      !connection.chatToken
    ) {
      agentsRef.current = [];
      setAgents([]);
      setDiscoveryError('');
      return;
    }
    const abort = new AbortController();
    let latest = 0;
    const refresh = () => {
      const request = ++latest;
      void voiceApi
        .liveAgents(connection.chatToken, abort.signal)
        .then((value) => {
          if (!abort.signal.aborted && request === latest) {
            agentsRef.current = value;
            setAgents(value);
            setDiscoveryError('');
            live.current?.updateAgents(value);
          }
        })
        .catch((error: unknown) => {
          if (!abort.signal.aborted && request === latest)
            setDiscoveryError(
              error instanceof Error && !(error instanceof TypeError)
                ? error.message
                : t('voice.liveDiscoveryError'),
            );
        });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      clearInterval(timer);
      abort.abort();
    };
  }, [
    connection,
    connection.status,
    connection.chatToken,
    mode,
    state.sending,
    t,
  ]);
  useEffect(() => {
    const voice = new SpatialVoice(connection, setState);
    const transcriber = new SpatialTranscriber(
      () => connection.chatToken,
      setTranscript,
    );
    transcriberRef.current = transcriber;
    const conversation = new LiveAgentConversation(connection, setLiveState);
    live.current = conversation;
    voice.onMicrophone = (stream) => {
      if (!stream) {
        transcriber.stop();
        conversation.stop();
      } else if (modeRef.current === 'live') {
        transcriber.stop();
        const context = voice.liveAudioContext;
        if (context)
          void conversation.start(stream, context).then(() => {
            if (modeRef.current === 'live')
              conversation.updateAgents(agentsRef.current);
          });
      } else if (selectedAsr.current.id) {
        conversation.stop();
        void transcriber.start(stream, selectedAsr.current);
      } else {
        setTranscript((previous) => ({
          ...previous,
          error: selectionStatus.current.loading
            ? '正在读取识别服务分配；语音通话仍可使用。'
            : selectionStatus.current.error ||
              '服务器尚未配置附近语音的识别服务；语音通话仍可使用。',
        }));
      }
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
      conversation.stop();
      live.current = null;
      voice.dispose();
      transcriber.stop();
      transcriberRef.current = null;
      engine.current = null;
    };
  }, [connection]);
  useEffect(() => {
    engine.current?.update();
    live.current?.update();
  }, [connection.players, connection.status]);

  const micDisabled =
    connection.status !== 'connected' || connection.chatRecording;
  const listenDisabled = connection.status !== 'connected';
  const toggleMic = async () => {
    if (micDisabled) return;
    const voice = engine.current;
    if (!voice) return;
    if (voice.state.sending || voice.state.pending) {
      voice.stopMic();
      return;
    }
    const startingMode = modeRef.current;
    if (startingMode === 'live' && !voice.state.listening) {
      await voice.setListening(true);
      if (!voice.state.listening || modeRef.current !== startingMode) return;
    }
    await voice.startMic();
  };
  const toggleListen = () => {
    if (listenDisabled) return;
    if (state.listening && modeRef.current === 'live' && state.sending)
      engine.current?.stopMic();
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
        void toggleMic();
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
  const nearbyAgents = connection.self
    ? connection.players.filter(
        (player) =>
          player.kind === 'ai-agent' &&
          player.connected &&
          spatialMix(player, connection.self!).gain >=
            SPEECH_HEARING_THRESHOLD &&
          spatialMix(connection.self!, player).gain >= SPEECH_HEARING_THRESHOLD,
      )
    : [];
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
        {(liveState.humanText || liveState.agentText) &&
          liveState.status !== 'idle' && (
            <div className="spatial-live-caption" role="status">
              {liveState.agentText
                ? `${t('voice.liveAgent')}: ${liveState.agentText}`
                : `${t('voice.liveYou')}: ${liveState.humanText}`}
            </div>
          )}
        {(state.error ||
          transcript.error ||
          liveState.error ||
          discoveryError) && (
          <p role="alert" className="spatial-error-summary">
            {state.error ||
              transcript.error ||
              liveState.error ||
              discoveryError}
          </p>
        )}
        {mode === 'live' && state.sending && !discoveryError && (
          <div className="live-agent-controls">
            <span role="status">
              {agents.length
                ? t('voice.liveNearby', { count: agents.length })
                : nearbyAgents.length
                  ? t('voice.liveUnconfigured')
                  : t('voice.liveWaiting')}
            </span>
          </div>
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
            onClick={() => void toggleMic()}
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
