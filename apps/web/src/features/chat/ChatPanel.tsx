import { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n';
import type { Connection } from '../../network/connection';
import { ChatMessages } from './components/ChatMessages';
import { ChatComposer } from './components/ChatComposer';
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
    scope,
    setScope,
    recipients,
    setRecipients,
    picker,
    setPicker,
    panel,
    input,
    busy,
    openPicker,
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
      className={`chat enhanced-chat${collapsed ? ' is-collapsed' : ''}`}
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
        <ChatComposer controller={controller} />
      </div>
    </section>
  );
}
