import { useEffect, useRef, useState, type RefObject } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { CircleAlert, FileText, X } from 'lucide-react';
import { useI18n } from '../../../i18n';

/** Input feedback floats above the composer without changing the chat's height. */
export function ComposerNotice({
  error,
  overflow,
  canRestore,
  onRestore,
  onOpen,
  anchor,
}: {
  error: string;
  overflow: string;
  canRestore: boolean;
  onRestore: () => void;
  onOpen: () => void;
  anchor: RefObject<HTMLFormElement | null>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(!!error);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (error) {
      setOpen(true);
      onOpen();
    }
  }, [error, onOpen]);
  const title = overflow ? t('chat.retainedText') : t('chat.inputIssue');
  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) onOpen();
      }}
    >
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          className="chat-notice-trigger"
          aria-label={title}
          title={title}
        >
          {overflow ? (
            <FileText size={16} aria-hidden="true" />
          ) : (
            <CircleAlert size={16} aria-hidden="true" />
          )}
        </button>
      </Popover.Trigger>
      <span className="chat-sr-only" role={error ? 'alert' : 'status'}>
        {error || t('chat.retainedText')}
      </span>
      <Popover.Portal>
        <Popover.Content
          className="chat-input-notice"
          data-hud
          aria-label={title}
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onFocusOutside={(event) => {
            // Finishing capture restores the input focus; keep its new error visible.
            if (anchor.current?.contains(event.target as Node))
              event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (restoreFocus.current) trigger.current?.focus();
            restoreFocus.current = false;
          }}
          onEscapeKeyDown={(event) => {
            if (event.isComposing) event.preventDefault();
            restoreFocus.current = true;
            event.stopPropagation();
          }}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="chat-notice-heading">
            <strong>{title}</strong>
            <button
              type="button"
              aria-label={t('chat.closeInputNotice')}
              onClick={() => {
                restoreFocus.current = true;
                setOpen(false);
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          {error && <p>{error}</p>}
          {overflow && (
            <>
              <textarea
                readOnly
                aria-label={t('chat.pendingConfirmedSentence')}
                value={overflow}
                rows={3}
              />
              <button
                type="button"
                className="chat-restore-text"
                disabled={!canRestore}
                onClick={() => {
                  setOpen(false);
                  onRestore();
                }}
              >
                {t('chat.fillBlankInput')}
              </button>
              {!canRestore && <small>{t('chat.restoreAfterDraft')}</small>}
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
