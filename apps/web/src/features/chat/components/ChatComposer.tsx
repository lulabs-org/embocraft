import { useCallback, useEffect, useId, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  ArrowUp,
  LoaderCircle,
  AtSign,
  Mic,
  Plus,
  Square,
  AudioLines,
  X,
} from 'lucide-react';
import { useI18n } from '../../../i18n';
import { mentionQuery } from '../chat-mentions';
import type { ChatController } from '../hooks/useChatController';
import { VoiceDraft } from './VoiceDraft';
import { MentionPicker } from './MentionPicker';
import { ComposerNotice } from './ComposerNotice';

function RecordingClock() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="chat-recording-clock" aria-hidden="true">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  );
}

export function ChatComposer({
  controller: c,
}: {
  controller: ChatController;
}) {
  const { t } = useI18n();
  const [more, setMore] = useState(false);
  const [playbackError, setPlaybackError] = useState('');
  const { setPicker } = c;
  const openNotice = useCallback(() => {
    setMore(false);
    setPicker(null);
  }, [setPicker]);
  const actionSelected = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const actionsId = useId();
  const composer = useRef<HTMLFormElement>(null);
  const wasOccupied = useRef(c.busy || !!c.clip);
  useEffect(() => {
    const occupied = c.busy || !!c.clip;
    if (wasOccupied.current && !occupied && !c.collapsed)
      c.input.current?.focus();
    wasOccupied.current = occupied;
  }, [c.busy, c.clip, c.collapsed, c.input]);
  const canFinishDictationAndSend =
    (c.mode === 'dictating' || c.mode === 'transcribing') &&
    !c.dictationSending;
  const canFinishRecordingAndSend = c.mode === 'recording';
  const canFinishAndSend =
    canFinishDictationAndSend || canFinishRecordingAndSend;
  const sendLabel = canFinishRecordingAndSend
    ? t('chat.finishRecordingAndSend')
    : canFinishDictationAndSend
      ? t('chat.finishDictationAndSend')
      : c.clip || c.mode === 'finalizing'
        ? t('chat.sendAudio')
        : t('chat.send');
  const recording = c.mode === 'dictating' || c.mode === 'recording';
  const showMore = more && !c.busy && !c.clip && !c.picker && !c.collapsed;
  const cancelLabel =
    c.mode === 'sending' ? t('chat.cancelSending') : t('common.cancel');
  const stateLabel = c.dictationSending
    ? t('chat.confirmingAndSending')
    : c.mode === 'permission'
      ? t('chat.requestingMic')
      : c.mode === 'dictating'
        ? t('chat.dictating')
        : c.mode === 'finalizing'
          ? t('chat.finishingRecording')
          : c.mode === 'recording'
            ? t('chat.recording')
            : c.mode === 'transcribing'
              ? t('chat.recognizing')
              : c.clip
                ? t('chat.sendingAudio')
                : t('chat.sending');
  const closeForAction = () => {
    actionSelected.current = true;
    setMore(false);
  };

  return (
    <Popover.Root
      open={showMore}
      onOpenChange={(open) => {
        if (open) {
          actionSelected.current = false;
          c.setPicker(null);
        }
        setMore(open);
      }}
    >
      <div className="chat-composer-wrap">
        <Popover.Portal>
          <Popover.Content
            className="chat-more-actions"
            id={actionsId}
            data-hud
            aria-label={t('chat.moreActions')}
            side="top"
            align="start"
            sideOffset={10}
            collisionPadding={12}
            onCloseAutoFocus={(event) => {
              // Picker and draft actions manage their own destination focus.
              if (actionSelected.current) event.preventDefault();
            }}
            onEscapeKeyDown={(event) => {
              if (event.isComposing) event.preventDefault();
              event.stopPropagation();
            }}
            onKeyDown={(event) => event.stopPropagation()}
            onKeyUp={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                closeForAction();
                c.openPicker();
              }}
            >
              <AtSign size={16} aria-hidden="true" />
              {t('chat.pickMention')}
            </button>
            <button
              type="button"
              disabled={!c.connected}
              onClick={() => {
                closeForAction();
                c.record('audio');
              }}
            >
              <AudioLines size={16} aria-hidden="true" />
              {t('chat.recordVoice')}
            </button>
          </Popover.Content>
        </Popover.Portal>
        <form
          ref={composer}
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!c.connected) return;
            if (canFinishRecordingAndSend) c.finishRecording(true);
            else if (canFinishDictationAndSend) c.finishDictation(true);
            else if (!c.busy) void c.send();
          }}
        >
          {c.busy ? (
            <button
              type="button"
              className="chat-composer-icon"
              disabled={c.mode === 'sending' && !c.clip}
              aria-label={cancelLabel}
              title={cancelLabel}
              onClick={() => {
                if (c.mode === 'sending') c.upload.current?.abort();
                else c.cancel();
              }}
            >
              <X size={18} aria-hidden="true" />
            </button>
          ) : c.clip ? (
            <button
              type="button"
              className="chat-composer-icon"
              aria-label={t('chat.discardRecording')}
              title={t('chat.discardRecording')}
              onClick={() => {
                setMore(false);
                c.setClip(undefined);
                c.setStatus('');
                c.setError('');
              }}
            >
              <X size={18} aria-hidden="true" />
            </button>
          ) : (
            <Popover.Trigger asChild>
              <button
                ref={trigger}
                type="button"
                className="chat-composer-icon"
                aria-label={t('chat.moreActions')}
                title={t('chat.moreActions')}
                aria-expanded={showMore}
                aria-controls={showMore ? actionsId : undefined}
              >
                <Plus size={20} aria-hidden="true" />
              </button>
            </Popover.Trigger>
          )}
          {c.busy ? (
            <div className="chat-recording">
              {recording ? (
                <span className="chat-recording-dot" aria-hidden="true" />
              ) : (
                <LoaderCircle
                  className="chat-progress-spinner"
                  size={15}
                  aria-hidden="true"
                />
              )}
              <span className="chat-recording-label" role="status">
                {c.dictationSending ? stateLabel : c.partial || stateLabel}
              </span>
              {(recording || c.mode === 'transcribing') && <RecordingClock />}
            </div>
          ) : c.clip && c.preview ? (
            <VoiceDraft
              key={c.preview}
              src={c.preview}
              durationMs={c.clipDuration}
              busy={c.busy}
              onErrorChange={setPlaybackError}
            />
          ) : (
            <input
              ref={c.input}
              className="chat-composer-input"
              aria-label={t('chat.inputAria')}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={c.picker?.source === 'input'}
              aria-activedescendant={
                c.picker?.source === 'input' && c.candidates.length
                  ? `mention-${c.candidates[c.activeChoice].id}`
                  : undefined
              }
              aria-controls={c.picker ? 'chat-mentions' : undefined}
              placeholder={
                c.scope === 'private'
                  ? c.recipients.length
                    ? t('chat.placeholderPrivate')
                    : t('chat.placeholderPickFirst')
                  : t('chat.placeholderPublic')
              }
              value={c.text}
              maxLength={240}
              onKeyDown={c.onKey}
              onChange={(event) => {
                setMore(false);
                c.setText(event.target.value);
                const pos = event.target.selectionStart ?? 0;
                c.caret.current = pos;
                c.setPicker(mentionQuery(event.target.value, pos));
                c.setChoice(0);
              }}
              onSelect={(event) => {
                c.caret.current = event.currentTarget.selectionStart ?? 0;
                if (c.picker?.source === 'input')
                  c.setPicker(
                    mentionQuery(event.currentTarget.value, c.caret.current),
                  );
              }}
            />
          )}
          {recording ? (
            <button
              type="button"
              className="chat-composer-icon"
              aria-label={t('chat.endRecording')}
              title={t('chat.endRecording')}
              onClick={() => {
                if (c.mode === 'dictating') {
                  c.finishDictation();
                } else c.finishRecording();
              }}
            >
              <Square size={15} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            !c.busy &&
            !c.clip && (
              <button
                type="button"
                className="chat-composer-icon"
                disabled={!c.connected}
                aria-label={t('chat.voiceToText')}
                title={t('chat.voiceToText')}
                onClick={() => {
                  setMore(false);
                  c.record('text');
                }}
              >
                <Mic size={19} aria-hidden="true" />
              </button>
            )
          )}
          {!c.busy && (c.error || playbackError || c.overflow) && (
            <ComposerNotice
              error={c.error || playbackError}
              overflow={c.overflow}
              canRestore={!c.text.trim() && !c.clip}
              anchor={composer}
              onOpen={openNotice}
              onRestore={() => {
                // Keep any remainder instead of losing a sentence over the input limit.
                c.setText(c.overflow.slice(0, 240));
                c.setOverflow(c.overflow.slice(240));
                c.setError('');
                c.setStatus('');
                c.input.current?.focus();
              }}
            />
          )}
          <button
            type="submit"
            className="chat-send"
            disabled={
              !c.connected ||
              (c.busy && !canFinishAndSend) ||
              (!canFinishAndSend && !c.clip && !c.text.trim()) ||
              (c.scope === 'private' && !c.recipients.length)
            }
            aria-label={sendLabel}
            title={sendLabel}
          >
            <ArrowUp size={20} aria-hidden="true" />
          </button>
        </form>
        <MentionPicker
          controller={c}
          anchor={composer}
          fallbackFocus={trigger}
        />
      </div>
    </Popover.Root>
  );
}
