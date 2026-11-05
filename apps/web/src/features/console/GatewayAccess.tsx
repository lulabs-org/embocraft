import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { AlertCircle, HelpCircle, Lock, X } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { useI18n } from '../../i18n';
import { clearGatewayToken, saveGatewayToken } from '../../network/gateway';

export function GatewayAccess({
  open,
  status,
  error,
  onClose,
}: {
  open: boolean;
  status: string;
  error: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const connecting = status !== 'unauthorized';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    saveGatewayToken(trimmed);
    setToken('');
  };

  return (
    <Dialog
      open={open}
      id="control-console-auth"
      className="agent-dialog console-locked"
      aria-labelledby="console-auth-title"
      onCancel={onClose}
    >
      <div className="console-locked-header">
        <h2 id="console-auth-title" className="console-locked-title">
          <Lock size={12} strokeWidth={2.4} />
          {t('console.eyebrow')}
        </h2>
        <button
          type="button"
          className="console-locked-close"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      <div className="console-access">
        {connecting ? (
          <div className="console-access-pending">
            <p role="status">{t('console.gateway.connecting')}</p>
            <Button onClick={clearGatewayToken}>
              {t('console.gateway.changeToken')}
            </Button>
          </div>
        ) : (
          <form className="console-access-form" onSubmit={handleSubmit}>
            <div className="console-access-input-group">
              <input
                id="console-admin-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                placeholder={t('console.gateway.adminTokenPlaceholder')}
                autoFocus
                required
                aria-label={t('console.gateway.adminTokenAria')}
                aria-describedby="console-token-storage"
                aria-invalid={!!error}
              />
              <Button
                type="submit"
                className="primary"
                disabled={!token.trim()}
              >
                {t('console.gateway.unlock')}
              </Button>
            </div>

            {error && (
              <p className="console-locked-error" role="alert">
                <AlertCircle size={13} strokeWidth={2} />
                {error}
              </p>
            )}

            <div className="console-access-meta">
              <p id="console-token-storage" className="console-access-hint">
                {t('console.gateway.tabOnlyHint')}
              </p>
              <Popover.Root>
                <Popover.Trigger
                  className="console-token-help-button"
                  aria-label={t('console.gateway.tokenHelpLabel')}
                >
                  <HelpCircle size={16} aria-hidden="true" />
                </Popover.Trigger>
                <Popover.Content
                  className="console-token-help"
                  aria-label={t('console.gateway.tokenHelpLabel')}
                  aria-describedby="console-token-source"
                  side="top"
                  align="end"
                  sideOffset={6}
                  collisionPadding={12}
                >
                  <p id="console-token-source" className="console-access-hint">
                    {t('console.gateway.tokenSourceHint')}
                  </p>
                  <Popover.Arrow />
                </Popover.Content>
              </Popover.Root>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}

