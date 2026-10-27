import type { Player } from '@voxel/shared';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  BailianSpeechSession,
  BrowserRecognitionSession,
  ClipRecorder,
  LiveRecorder,
  LiveSpeechSession,
  speechTransport,
} from '../../../audio';
import { useAsrSelection } from '../../voice';
import type { Connection } from '../../../network/connection';
import { chatApi } from '../api';
import { consumeMention, mentionQuery } from '../chat-mentions';
export function useChatController(connection: Connection, expanded = true) {
  const collapsed = !expanded;
  const [collapsedAt, setCollapsedAt] = useState(0);
  const latestChatSeq = connection.chats.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (expanded) setCollapsedAt(latestChatSeq);
  }, [expanded, latestChatSeq]);
  const unread = collapsed
    ? connection.chats.filter(
        (entry) =>
          entry.seq > collapsedAt && entry.actor !== connection.room?.sessionId,
      ).length
    : 0;
  const [text, setText] = useState(''),
    [scope, setScope] = useState<'public' | 'private'>('public'),
    [recipients, setRecipients] = useState<Player[]>([]);
  const [picker, setPicker] = useState<
    | NonNullable<ReturnType<typeof mentionQuery>>
    | { source: 'button'; query: string }
    | null
  >(null);
  const [choice, setChoice] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const caret = useRef(0);
  const [status, setStatus] = useState(''),
    [error, setError] = useState(''),
    [mode, setMode] = useState<
      | 'idle'
      | 'permission'
      | 'dictating'
      | 'transcribing'
      | 'recording'
      | 'sending'
    >('idle');
  const [partial, setPartial] = useState('');
  const [overflow, setOverflow] = useState('');
  const dictated = useRef('');
  const activeDictation = useRef<'browser' | 'server'>('server');
  const [clipDuration, setClipDuration] = useState(0);
  const [clip, setClip] = useState<Blob>(),
    [preview, setPreview] = useState('');
  const input = useRef<HTMLInputElement>(null),
    list = useRef<HTMLDivElement>(null),
    upload = useRef<AbortController | undefined>(undefined);
  const [dictation] = useState(() => new LiveRecorder()),
    [browserDictation] = useState(() => new BrowserRecognitionSession()),
    [recorder] = useState(() => new ClipRecorder());
  const asr = useAsrSelection('chat');
  const clipAsr = useAsrSelection('clip');
  const connected = connection.status === 'connected',
    busy = mode !== 'idle';
  const candidates = connection.players
    .filter(
      (p) =>
        p.connected &&
        p.id !== connection.room?.sessionId &&
        !recipients.some((r) => r.id === p.id) &&
        p.name
          .toLowerCase()
          .includes((picker?.query ?? '').trim().toLowerCase()),
    )
    .sort((a, b) => Number(b.kind !== 'human') - Number(a.kind !== 'human'));
  const activeChoice = candidates.length ? choice % candidates.length : 0;
  useEffect(() => {
    if (picker?.source === 'button') search.current?.focus();
  }, [picker?.source]);
  const pickerQuery = picker?.query;
  useEffect(() => {
    if (pickerQuery === undefined) return;
    panel.current
      ?.querySelector('[role=option][aria-selected=true]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [choice, pickerQuery]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) setPicker(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  useEffect(() => {
    if (!clip) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(clip);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [clip]);
  const cancel = useCallback(() => {
    dictation.cancel();
    browserDictation.cancel();
    recorder.cancel();
    upload.current?.abort();
    connection.chatRecording = false;
    setMode('idle');
    setPartial('');
    setStatus('');
  }, [connection, dictation, browserDictation, recorder]);
  useEffect(() => {
    if (!connected) cancel();
  }, [connected, cancel]);
  useEffect(
    () => () => {
      dictation.cancel();
      browserDictation.cancel();
      recorder.cancel();
      upload.current?.abort();
      connection.chatRecording = false;
    },
    [connection, dictation, browserDictation, recorder],
  );
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [connection.chats.length]);
  const openPicker = () => {
    setPicker({ source: 'button', query: '' });
    setChoice(0);
    setError('');
  };
  const select = (p: Player) => {
    if (recipients.some((r) => r.id === p.id)) return;
    if (recipients.length >= 8) {
      setError('最多选择 8 位接收者，请先移除一位。');
      return;
    }
    const next =
      picker?.source === 'input'
        ? consumeMention(text, picker.start, picker.end)
        : { text, caret: caret.current };
    setText(next.text);
    setRecipients((r) => [...r, p]);
    setPicker(null);
    setError('');
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter confirms an IME candidate; it must never select a player or send.
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      if (e.key === 'Enter') e.preventDefault();
      return;
    }
    if (!picker) return;
    if (e.key === 'Escape') {
      setPicker(null);
      e.preventDefault();
      e.stopPropagation();
      input.current?.focus();
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setChoice(
        (n) =>
          (n +
            (e.key === 'ArrowDown' ? 1 : -1) +
            Math.max(1, candidates.length)) %
          Math.max(1, candidates.length),
      );
    }
    if (e.key === 'Enter' || (e.key === 'Tab' && candidates.length)) {
      e.preventDefault();
      if (candidates.length) select(candidates[activeChoice]);
    }
  };
  const record = (kind: 'text' | 'audio') => {
    if (kind === 'text' && overflow) {
      setError('请先处理下方保留的已确认句子，再继续听写。');
      return;
    }
    dictated.current = text;
    if (connection.voiceLabRecording) {
      setError('请先结束语音设置中的录音。');
      return;
    }
    if (!(kind === 'text' ? asr.selected.id : clipAsr.selected.id)) {
      setError('请先在控制台的“识别服务选择”中选择对应的识别服务。');
      return;
    }
    connection.stopSpatialInput();
    connection.chatRecording = true;
    setError('');
    setMode('permission');
    setStatus('正在请求麦克风…');
    const fail = (message: string) => {
      connection.chatRecording = false;
      setMode('idle');
      setError(message);
      setStatus('');
    };
    if (kind === 'text') {
      const service = asr.selected;
      activeDictation.current =
        service.provider === 'browser' ? 'browser' : 'server';
      const language = service.language ?? 'zh-CN';
      const callbacks = {
        onState: (state: 'listening' | 'thinking') => {
          setMode(state === 'listening' ? 'dictating' : 'transcribing');
          setStatus(
            state === 'listening'
              ? '听写中，停顿后确认整句；结束后可编辑再发送。'
              : '正在服务器识别…',
          );
        },
        onPartial: setPartial,
        onStatus: setStatus,
        onFinal: (value: string) => {
          const next = (dictated.current + ' ' + value).trim();
          if (next.length > 240) {
            dictation.cancel();
            browserDictation.cancel();
            setPartial('');
            setOverflow(value);
            fail('输入框最多 240 字，听写已停止。本句保留在下方，请分开发送。');
            return;
          }
          dictated.current = next;
          setText(next);
          setStatus('整句已确认，可以继续讲话；结束后确认发送。');
        },
        onEnd: () => {
          connection.chatRecording = false;
          setPartial('');
          setMode('idle');
          setStatus('已转为文字，请确认后发送。');
        },
        onError: fail,
      };
      if (service.provider === 'browser') {
        setMode('dictating');
        browserDictation.start(language, {
          ...callbacks,
          onStatus: setStatus,
        });
      } else {
        void dictation.start(
          language,
          {
            ...callbacks,
            onStatus: setStatus,
          },
          undefined,
          undefined,
          service.provider === 'bailian'
            ? (events) => new BailianSpeechSession(service.id, language, events)
            : (events) =>
                new LiveSpeechSession(
                  speechTransport(language, undefined, undefined, service.id),
                  events,
                ),
        );
      }
    } else
      void recorder.start(
        (blob, durationMs) => {
          connection.chatRecording = false;
          setClipDuration(durationMs);
          setClip(blob);
          setMode('idle');
          setStatus('');
        },
        fail,
        () => {
          setMode('recording');
          setStatus('录制语音消息中，最长 20 秒。');
        },
      );
  };
  const send = async () => {
    setError('');
    if (clip && !clipAsr.selected.id) {
      setError('请先在控制台为“聊天录语音转文字”选择识别服务。');
      return;
    }
    const ids = recipients.map((p) => p.id);
    if (scope === 'private' && !ids.length) {
      setError('请先通过 @ 选择私聊对象。');
      return;
    }
    if (
      ids.some(
        (id) => !connection.players.some((p) => p.id === id && p.connected),
      )
    ) {
      setError('接收对象已离线，请移除或重新选择。');
      return;
    }
    if (!clip && !text.trim()) return;
    setPicker(null);
    setMode('sending');
    const abort = new AbortController();
    upload.current = abort;
    try {
      if (clip) {
        setStatus('正在上传语音并由服务器转写…');
        const timer = setTimeout(() => abort.abort(), 125000);
        try {
          const data = await chatApi.uploadAudio(
            clip,
            scope,
            ids,
            connection.chatToken,
            abort.signal,
            clipAsr.selected.id,
          );
          setStatus(
            data.transcriptAvailable
              ? '语音已发送，Agent 可读取转写。'
              : '语音已发送，暂未生成文字转写，Agent 无法理解此段录音。',
          );
        } finally {
          clearTimeout(timer);
        }
        setClip(undefined);
        setText('');
      } else {
        await connection.requestAction('chat', {
          text,
          scope,
          recipients: ids,
        });
        setText('');
        setStatus('已发送。');
      }
      if (scope === 'public') setRecipients([]);
      input.current?.focus();
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
      else setError('发送已取消或超时，请确认消息记录后再重试。');
    } finally {
      setMode('idle');
    }
  };

  return {
    connection,
    collapsed,
    setCollapsedAt,
    unread,
    text,
    setText,
    scope,
    setScope,
    recipients,
    setRecipients,
    picker,
    setPicker,
    setChoice,
    panel,
    search,
    caret,
    status,
    setStatus,
    error,
    setError,
    mode,
    setMode,
    partial,
    overflow,
    setOverflow,
    clipDuration,
    clip,
    setClip,
    preview,
    input,
    list,
    upload,
    dictation,
    recorder,
    connected,
    busy,
    candidates,
    activeChoice,
    cancel,
    finishDictation: () => {
      if (activeDictation.current === 'browser') browserDictation.finish();
      else void dictation.finish();
    },
    openPicker,
    select,
    onKey,
    record,
    send,
  };
}
export type ChatController = ReturnType<typeof useChatController>;
