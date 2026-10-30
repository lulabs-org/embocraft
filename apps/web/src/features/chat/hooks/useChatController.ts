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
type CaptureRun = {
  finishing: boolean;
  send: boolean;
  fail: (message: string) => void;
};

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
      | 'finalizing'
      | 'sending'
    >('idle');
  const [partial, setPartial] = useState('');
  const [overflow, setOverflow] = useState('');
  const dictated = useRef('');
  const dictationRun = useRef<CaptureRun | null>(null);
  const clipRun = useRef<CaptureRun | null>(null);
  const [dictationSending, setDictationSending] = useState(false);
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
    if (!clip) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(clip);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [clip]);
  const cancel = useCallback(() => {
    dictationRun.current = null;
    clipRun.current = null;
    setDictationSending(false);
    dictation.cancel();
    browserDictation.cancel();
    recorder.cancel();
    upload.current?.abort();
    upload.current = undefined;
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
      dictationRun.current = null;
      clipRun.current = null;
      dictation.cancel();
      browserDictation.cancel();
      recorder.cancel();
      upload.current?.abort();
      upload.current = undefined;
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
    if (
      busy ||
      clip ||
      dictationRun.current ||
      clipRun.current ||
      upload.current
    )
      return;
    if (kind === 'text' && overflow) {
      setError('请先处理保留的已确认句子，再继续听写。');
      return;
    }
    dictated.current = text;
    if (connection.voiceLabRecording) {
      setError('请先结束语音设置中的录音。');
      return;
    }
    if (!(kind === 'text' ? asr.selected.id : clipAsr.selected.id)) {
      setError('请先在控制台的“识别服务分配”中为此功能指定识别服务。');
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
      // A run owns its callbacks and send intent, even if old results arrive late.
      const run: CaptureRun = {
        finishing: false,
        send: false,
        fail: (message) => {
          if (dictationRun.current !== run) return;
          dictationRun.current = null;
          dictation.cancel();
          browserDictation.cancel();
          setDictationSending(false);
          setPartial('');
          fail(
            run.send
              ? `${message} 未发送，已确认文字已保留，请检查后重试。`
              : message,
          );
        },
      };
      dictationRun.current = run;
      const worldSession = connection.room?.sessionId;
      const current = () => {
        if (dictationRun.current !== run) return false;
        if (
          connection.status !== 'connected' ||
          connection.room?.sessionId !== worldSession
        ) {
          run.fail('世界连接已变化，听写已停止。');
          return false;
        }
        return true;
      };
      const callbacks = {
        onState: (state: 'listening' | 'thinking') => {
          if (!current()) return;
          if (run.finishing) return;
          setMode(state === 'listening' ? 'dictating' : 'transcribing');
          setStatus(
            state === 'listening'
              ? '听写中，可直接发送；也可先停止检查文字。'
              : '正在识别…',
          );
        },
        onPartial: (value: string) => {
          if (current()) setPartial(value);
        },
        onStatus: (value: string) => {
          if (current() && !run.finishing) setStatus(value);
        },
        onFinal: (value: string) => {
          if (!current()) return;
          const next = (dictated.current + ' ' + value).trim();
          if (next.length > 240) {
            setOverflow(value);
            run.fail(
              '输入框最多 240 字，听写已停止。超出的句子已保留，请分开发送。',
            );
            return;
          }
          dictated.current = next;
          setText(next);
          if (!run.finishing) setStatus('');
        },
        onEnd: () => {
          if (!current()) return;
          dictationRun.current = null;
          connection.chatRecording = false;
          setPartial('');
          setMode('idle');
          setDictationSending(false);
          if (run.send) {
            // onFinal updates this ref synchronously; React state may still be batched.
            if (!dictated.current.trim()) {
              setStatus('');
              setError('没有识别到可发送的文字，请重新听写或输入消息。');
            } else void send(dictated.current);
          } else setStatus('');
        },
        onError: run.fail,
      };
      if (service.provider === 'browser') {
        setMode('dictating');
        browserDictation.start(language, callbacks);
      } else {
        void dictation.start(
          language,
          callbacks,
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
    } else {
      const run: CaptureRun = {
        finishing: false,
        send: false,
        fail: (message) => {
          if (clipRun.current !== run) return;
          clipRun.current = null;
          recorder.cancel();
          fail(run.send ? `${message} 语音未发送，请重新录制。` : message);
        },
      };
      clipRun.current = run;
      const worldSession = connection.room?.sessionId;
      const current = () => {
        if (clipRun.current !== run) return false;
        if (
          connection.status !== 'connected' ||
          connection.room?.sessionId !== worldSession
        ) {
          run.fail('世界连接已变化，录音已停止。');
          return false;
        }
        return true;
      };
      void recorder.start(
        (blob, durationMs) => {
          if (!current()) return;
          if (!blob.size) {
            run.fail('录音为空，请重试。');
            return;
          }
          clipRun.current = null;
          connection.chatRecording = false;
          setClipDuration(durationMs);
          setClip(blob);
          setMode('idle');
          setStatus('');
          // MediaRecorder's final dataavailable has already joined this blob.
          // Use the callback value directly, before React commits the draft state.
          if (run.send) void send(text, blob);
        },
        run.fail,
        () => {
          if (!current() || run.finishing) return;
          setMode('recording');
          setStatus('录制语音消息中，最长 20 秒。');
        },
      );
    }
  };
  const finishRecording = (sendAfter = false) => {
    const run = clipRun.current;
    if (!run || run.finishing) return;
    run.send = sendAfter;
    run.finishing = true;
    setMode('finalizing');
    setStatus(sendAfter ? '正在完成录音，完成后自动发送…' : '正在完成录音…');
    try {
      recorder.finish();
    } catch {
      run.fail('无法结束录音，请重试。');
    }
  };
  const finishDictation = (sendAfter = false) => {
    const run = dictationRun.current;
    if (!run) return;
    run.send ||= sendAfter;
    setDictationSending(run.send);
    setMode('transcribing');
    setStatus(
      run.send ? '正在确认最后一句，完成后自动发送…' : '正在确认最后一句…',
    );
    if (run.finishing) return;
    run.finishing = true;
    try {
      if (activeDictation.current === 'browser') browserDictation.finish();
      else
        void dictation.finish().catch(() => run.fail('无法结束听写，请重试。'));
    } catch {
      run.fail('无法结束听写，请重试。');
    }
  };
  const send = async (messageText = text, audioClip = clip) => {
    if (upload.current || dictationRun.current || clipRun.current) return;
    setError('');
    setStatus('');
    if (connection.status !== 'connected') {
      setError(
        audioClip
          ? '世界连接已断开，未发送；录音已保留，请连接后重试。'
          : '世界连接已断开，未发送；文字已保留，请连接后重试。',
      );
      return;
    }
    if (audioClip && !clipAsr.selected.id) {
      setError('请先在控制台为“语音消息转文字”选择识别服务。');
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
    if (!audioClip && !messageText.trim()) return;
    setPicker(null);
    setMode('sending');
    const abort = new AbortController();
    upload.current = abort;
    try {
      if (audioClip) {
        setStatus('正在发送语音…');
        const timer = setTimeout(() => abort.abort(), 125000);
        try {
          await chatApi.uploadAudio(
            audioClip,
            scope,
            ids,
            connection.chatToken,
            abort.signal,
            clipAsr.selected.id,
          );
          if (upload.current !== abort) return;
          if (abort.signal.aborted) throw new Error('发送已取消。');
          setStatus('');
        } finally {
          clearTimeout(timer);
        }
        setClip(undefined);
        setText('');
      } else {
        await connection.requestAction('chat', {
          text: messageText,
          scope,
          recipients: ids,
        });
        if (upload.current !== abort || abort.signal.aborted) return;
        setText('');
        setStatus('');
      }
      if (scope === 'public') setRecipients([]);
      input.current?.focus();
    } catch (e) {
      if (upload.current !== abort) return;
      setStatus('');
      if (!abort.signal.aborted)
        setError(
          audioClip
            ? `${(e as Error).message} 录音已保留，请确认消息记录后重试。`
            : `${(e as Error).message} 文字已保留，请确认消息记录后重试。`,
        );
      else setError('发送已取消或超时，请确认消息记录后再重试。');
    } finally {
      if (upload.current === abort) {
        upload.current = undefined;
        setMode('idle');
      }
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
    finishDictation,
    finishRecording,
    dictationSending,
    openPicker,
    select,
    onKey,
    record,
    send,
  };
}
export type ChatController = ReturnType<typeof useChatController>;
