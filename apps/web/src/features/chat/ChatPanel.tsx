import { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n';
import type { Connection } from '../../network/connection';
import { mentionQuery } from './chat-mentions';
import { ChatMessages } from './components/ChatMessages';
import { MentionPicker } from './components/MentionPicker';
import { VoiceDraft } from './components/VoiceDraft';
import { useChatController } from './hooks/useChatController';
export function ChatPanel({
  connection,
  expanded,
  onExpandedChange,
  onBusyChange,
}: {
  connection: Connection;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const controller = useChatController(connection, expanded);

  const {
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
    upload,
    finishDictation,
    recorder,
    connected,
    busy,
    candidates,
    activeChoice,
    cancel,
    openPicker,
    onKey,
    record,
    send,
  } = controller;
  const entry = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(expanded);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (expanded) {
      input.current?.focus();
      controller.list.current?.scrollTo({
        top: controller.list.current.scrollHeight,
      });
    } else if (wasExpanded.current) entry.current?.focus();
    wasExpanded.current = expanded;
  }, [expanded, input, controller.list]);
  const close = () => {
    if (busy) return;
    setCollapsedAt(connection.chats.at(-1)?.seq ?? 0);
    setPicker(null);
    onExpandedChange(false);
  };
  return (
    <section
      ref={panel}
      data-hud
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        if (picker) {
          setPicker(null);
          input.current?.focus();
        } else close();
      }}
      className={`chat enhanced-chat${collapsed ? ' is-collapsed' : ''}${picker ? ' is-picking' : ''}${picker?.source === 'button' ? ' picker-manual' : ''}`}
      aria-label={t('chat.ariaLabel')}
    >
      <div className="chat-peek" hidden={!collapsed}>
        {connection.chats.slice(-3).map((message) => (
          <button
            className="chat-peek-message"
            key={message.seq}
            onClick={() => onExpandedChange(true)}
          >
            <span>
              <strong>{message.data.name}</strong> ·{' '}
              {message.data.scope === 'private'
                ? t('chat.private')
                : message.data.scope === 'nearby'
                  ? t('chat.nearby')
                  : t('chat.public')}
            </span>
            <span>
              {message.data.kind === 'audio'
                ? t('chat.audioMessage')
                : message.data.text}
            </span>
          </button>
        ))}
        <button
          ref={entry}
          className="chat-entry"
          aria-label={t('chat.expandAria', {
            unread: unread
              ? `，${t('chat.unreadCount', { count: unread })}`
              : '',
          })}
          aria-expanded={expanded}
          onClick={() => onExpandedChange(true)}
        >
          {t('chat.chatEntry')} <kbd>Enter</kbd>
          {unread > 0 && (
            <span className="unread-count" aria-live="polite">
              {t('chat.unreadCount', { count: unread })}
            </span>
          )}
        </button>
      </div>
      <div className="chat-expanded" hidden={collapsed}>
        <div className="chat-title">
          <strong>{t('chat.title')}</strong>
          <div
            className="chat-scope"
            role="group"
            aria-label={t('chat.sendMode')}
          >
            <button
              type="button"
              aria-label={t('chat.publicLabel')}
              aria-pressed={scope === 'public'}
              disabled={busy}
              title={t('chat.publicDesc')}
              onClick={() => setScope('public')}
            >
              {t('chat.public')}
            </button>
            <button
              type="button"
              aria-label={t('chat.privateLabel')}
              aria-pressed={scope === 'private'}
              disabled={busy}
              title={t('chat.privateDesc')}
              onClick={() => {
                setScope('private');
                if (!recipients.length) openPicker();
              }}
            >
              {t('chat.private')}
            </button>
          </div>
          <button
            className="dock-collapse"
            aria-label={t('chat.collapse')}
            aria-expanded={true}
            title={busy ? t('chat.busyCollapse') : t('chat.unbusyCollapse')}
            disabled={busy}
            onClick={close}
          >
            ×
          </button>
        </div>
        <ChatMessages {...controller} />
        {recipients.length > 0 && (
          <div
            className="chat-recipients"
            aria-label={t('chat.selectedRecipientsAria')}
          >
            <span className="recipient-label">
              {scope === 'private' ? t('chat.sendTo') : t('chat.remind')}
            </span>
            {recipients.map((p) => (
              <button
                key={p.id}
                disabled={busy}
                onClick={() =>
                  setRecipients((r) => r.filter((x) => x.id !== p.id))
                }
                aria-label={t('chat.removeRecipient', { name: p.name })}
              >
                @{p.name}
                {connection.players.some((x) => x.id === p.id && x.connected)
                  ? ''
                  : t('chat.offlineTag')}{' '}
                ×
              </button>
            ))}
            <button
              type="button"
              disabled={busy}
              onClick={openPicker}
              aria-label={t('chat.addRecipient')}
            >
              ＋
            </button>
          </div>
        )}
        {preview && (
          <VoiceDraft
            key={preview}
            src={preview}
            durationMs={clipDuration}
            busy={busy}
            onDiscard={() => {
              setClip(undefined);
              setStatus('');
              setError('');
            }}
          />
        )}
        {picker && <MentionPicker {...controller} />}
        <form
          className={clip ? 'chat-audio-send-row' : undefined}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {clip ? (
            <span className="chat-audio-caption">
              {t('chat.previewAudioCaption')}
            </span>
          ) : (
            <div className="chat-input-wrap">
              <input
                ref={input}
                aria-label={t('chat.inputAria')}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={picker?.source === 'input'}
                aria-activedescendant={
                  picker?.source === 'input' && candidates.length
                    ? `mention-${candidates[activeChoice].id}`
                    : undefined
                }
                aria-controls="chat-mentions"
                placeholder={
                  scope === 'private'
                    ? recipients.length
                      ? t('chat.placeholderPrivate')
                      : t('chat.placeholderPickFirst')
                    : t('chat.placeholderPublic')
                }
                disabled={busy || !!clip}
                value={text}
                maxLength={240}
                onKeyDown={onKey}
                onChange={(e) => {
                  setText(e.target.value);
                  const pos = e.target.selectionStart ?? 0;
                  caret.current = pos;
                  setPicker(mentionQuery(e.target.value, pos));
                  setChoice(0);
                }}
                onSelect={(e) => {
                  caret.current = e.currentTarget.selectionStart ?? 0;
                  if (picker?.source !== 'button')
                    setPicker(
                      mentionQuery(e.currentTarget.value, caret.current),
                    );
                }}
              />
            </div>
          )}
          <button
            className={`chat-send${clip ? ' chat-send-audio' : ''}`}
            disabled={
              !connected ||
              busy ||
              (!clip && !text.trim()) ||
              (scope === 'private' && !recipients.length)
            }
            aria-label={clip ? t('chat.sendAudio') : t('chat.send')}
            title={clip ? t('chat.sendAudio') : t('chat.send')}
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="m21 3-6.5 18-4-7.5L3 9.5 21 3Z" />
              <path d="m10.5 13.5 5-5" />
            </svg>
            {clip && (
              <span>
                {mode === 'sending' ? t('chat.sending') : t('chat.sendAudio')}
              </span>
            )}
          </button>
        </form>
        <div className="chat-tools">
          {mode === 'dictating' || mode === 'recording' ? (
            <button
              onClick={() => {
                if (mode === 'dictating') {
                  setMode('transcribing');
                  finishDictation();
                } else recorder.finish();
              }}
            >
              {t('chat.endRecording')}
            </button>
          ) : (
            !clip && (
              <>
                <button
                  disabled={!connected || busy || !!clip}
                  onClick={() => record('text')}
                >
                  {t('chat.voiceToText')}
                </button>
                <button
                  disabled={!connected || busy || !!clip}
                  onClick={() => record('audio')}
                >
                  {t('chat.recordVoice')}
                </button>
              </>
            )
          )}
          {busy && mode !== 'sending' && (
            <button onClick={cancel}>{t('common.cancel')}</button>
          )}
          {busy && mode === 'sending' && clip && (
            <button onClick={() => upload.current?.abort()}>
              {t('chat.cancelSending')}
            </button>
          )}
          {!busy && (
            <button
              aria-label={t('chat.pickMentionAria')}
              aria-expanded={picker !== null}
              aria-controls="chat-mentions"
              onClick={openPicker}
            >
              {t('chat.pickMention')}
            </button>
          )}
        </div>
        <small className="chat-help chat-scope-help">
          {scope === 'private'
            ? t('chat.helpPrivate')
            : recipients.length
              ? t('chat.helpPublicMention')
              : t('chat.helpPublic')}
        </small>
        {partial && (
          <p className="speech-interim" role="status">
            {t('chat.interimCaption', { text: partial })}
          </p>
        )}
        {overflow && (
          <div className="speech-interim">
            <label>
              {t('chat.pendingConfirmedSentence')}
              <textarea readOnly value={overflow} rows={2} />
            </label>
            <button
              disabled={busy || !!text.trim()}
              onClick={() => {
                setText(overflow);
                setOverflow('');
                setError('');
                setStatus(t('chat.fillNotice'));
              }}
            >
              {t('chat.fillBlankInput')}
            </button>
          </div>
        )}
        {status && (
          <p role="status" className="chat-help">
            {status}
          </p>
        )}
        {error && (
          <p role="alert" className="chat-error">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
