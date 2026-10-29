import { useEffect, useRef, type RefObject } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Bot, Search, X } from 'lucide-react';
import { useI18n } from '../../../i18n/context';
import type { ChatController } from '../hooks/useChatController';

export function MentionPicker({
  controller: c,
  anchor,
  fallbackFocus,
}: {
  controller: ChatController;
  anchor: RefObject<HTMLFormElement | null>;
  fallbackFocus: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useI18n();
  const {
    connection,
    scope,
    recipients,
    picker,
    setPicker,
    setChoice,
    search,
    input,
    candidates,
    activeChoice,
    select,
    onKey,
  } = c;
  const list = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(true);
  const focusComposer = () => (input.current ?? fallbackFocus.current)?.focus();
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeChoice, picker?.query]);
  return (
    <Popover.Root
      open={!!picker && !c.busy && !c.collapsed}
      onOpenChange={(open) => {
        if (!open) setPicker(null);
      }}
    >
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content
          className="mention-picker"
          data-hud
          aria-label={
            scope === 'private'
              ? t('chat.mentionTitlePrivate')
              : t('chat.mentionTitlePublic')
          }
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus.current = true;
            if (picker?.source === 'button') search.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (restoreFocus.current && !c.busy && !c.collapsed)
              focusComposer();
          }}
          onInteractOutside={(event) => {
            // Autocomplete belongs to the input: typing and moving the caret
            // must not dismiss it or move focus into the suggestions.
            if (picker?.source === 'input' && event.target === input.current) {
              event.preventDefault();
            } else restoreFocus.current = false;
          }}
          onEscapeKeyDown={(event) => {
            if (event.isComposing) event.preventDefault();
            event.stopPropagation();
          }}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mention-heading">
            <strong>
              {scope === 'private'
                ? t('chat.mentionTitlePrivate')
                : t('chat.mentionTitlePublic')}
            </strong>
            <small
              aria-label={t('chat.mentionSelectedCount', {
                count: recipients.length,
              })}
              title={t('chat.mentionSelectedCount', {
                count: recipients.length,
              })}
            >
              {recipients.length}/8
            </small>
            <button
              type="button"
              aria-label={t('chat.closeMentionAria')}
              onClick={() => {
                setPicker(null);
                focusComposer();
              }}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
          {picker?.source === 'button' && (
            <div className="mention-search-wrap">
              <Search size={14} aria-hidden="true" />
              <input
                ref={search}
                className="mention-search"
                aria-label={t('chat.searchMentionAria')}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={true}
                aria-controls="chat-mentions"
                aria-activedescendant={
                  candidates.length
                    ? `mention-${candidates[activeChoice].id}`
                    : undefined
                }
                placeholder={t('chat.searchMentionPlaceholder')}
                value={picker?.query ?? ''}
                onKeyDown={onKey}
                onChange={(e) => {
                  setPicker({ source: 'button', query: e.target.value });
                  setChoice(0);
                }}
              />
            </div>
          )}
          <div
            ref={list}
            id="chat-mentions"
            className="mention-list"
            role="listbox"
            aria-label={t('chat.selectRecipientAria')}
          >
            {candidates.length ? (
              candidates.map((p, i) => (
                <button
                  type="button"
                  role="option"
                  id={`mention-${p.id}`}
                  aria-selected={activeChoice === i}
                  key={p.id}
                  title={`${p.name} · ${p.kind === 'human' ? t('worldPanel.player') : t('avatar.agent')} · ${t('chat.onlineTag')}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => select(p)}
                >
                  <span
                    className={`mention-avatar ${p.kind === 'human' ? 'human' : 'agent'}`}
                    data-tone={
                      Array.from(p.name).reduce(
                        (sum, char) => sum + (char.codePointAt(0) ?? 0),
                        0,
                      ) % 4
                    }
                    aria-hidden="true"
                  >
                    {p.kind === 'human' ? (
                      (Array.from(p.name.trim())[0]?.toLocaleUpperCase() ?? '?')
                    ) : (
                      <Bot size={15} strokeWidth={1.7} />
                    )}
                    <i className="mention-online" />
                  </span>
                  <span className="mention-name">
                    <span className="mention-label">{p.name}</span>
                    {connection.players.filter((other) => other.name === p.name)
                      .length > 1 && (
                      <small className="mention-id">#{p.id.slice(-4)}</small>
                    )}
                  </span>
                  <span className="mention-kind">
                    {p.kind === 'human'
                      ? t('worldPanel.player')
                      : t('avatar.agent')}
                  </span>
                  <span className="chat-sr-only">{t('chat.onlineTag')}</span>
                </button>
              ))
            ) : (
              <p className="mention-empty">
                {picker?.query.trim()
                  ? t('chat.noMatchFound')
                  : t('chat.noOnlineUsers')}
                <small>{t('chat.removeRecipientHint')}</small>
              </p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
