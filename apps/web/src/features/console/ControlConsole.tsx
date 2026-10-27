import { ConsoleFeedbackContext } from '../../components/ui/ConsoleFeedbackRelay';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { useI18n } from '../../i18n';
import type { Connection } from '../../network/connection';
import {
  clearGatewayToken,
  closeGateway,
  gatewayError,
  gatewayState,
  getGatewayToken,
  onGatewayState,
  openGateway,
} from '../../network/gateway';
import { SpeechRecognitionPanel } from '../voice';
import { AsrInputSettings } from './asr/AsrInputSettings';
import { AICharacters } from './ai-characters';
import { ConsoleHelp } from './ConsoleHelp';
import { GatewayAccess } from './GatewayAccess';
import { ProviderEditor } from './providers/ProviderEditor';
import { TaskPlans } from './tasks';
import { useConsoleController } from './useConsoleController';
import { VoiceServices } from './voice/VoiceServices';

type ConsoleProps = {
  connection: Connection;
  open: boolean;
  initialTab?: 'characters';
  onClose: () => void;
};
export function ControlConsole({
  connection,
  open,
  initialTab,
  onClose,
}: ConsoleProps) {
  const { t } = useI18n();
  const status = useSyncExternalStore(onGatewayState, gatewayState);
  const gatewayFailure = useSyncExternalStore(onGatewayState, gatewayError);
  const savedToken = useSyncExternalStore(onGatewayState, getGatewayToken);
  const [hasConnected, setHasConnected] = useState(false);
  const locked = !savedToken || status === 'unauthorized' || !hasConnected;
  useEffect(() => {
    if (!savedToken || status === 'unauthorized') setHasConnected(false);
    else if (status === 'ready') setHasConnected(true);
  }, [savedToken, status]);
  useEffect(() => {
    if (open) openGateway();
    return () => closeGateway();
  }, [open]);
  const controller = useConsoleController(
    open && status === 'ready',
    initialTab,
  );
  const {
    tab,
    setTab,
    providers,
    body,
    notice,
    setNotice,
    error,
    setError,
    selected,
    editProvider,
  } = controller;

  const notifications = useMemo(
    () => ({ setError, setNotice }),
    [setError, setNotice],
  );

  if (locked) {
    return (
      <GatewayAccess
        open={open}
        status={status}
        savedToken={savedToken}
        error={gatewayFailure}
        onClose={onClose}
      />
    );
  }

  return (
    <ConsoleFeedbackContext.Provider value={notifications}>
      <Dialog
        open={open}
        id="control-console"
        className="agent-dialog"
        aria-labelledby="agent-title"
        onCancel={onClose}
      >
        <div className="agent-chrome">
          <div className="agent-heading">
            <div>
              <div className="eyebrow">{t('console.eyebrow')}</div>
              <div className="console-title-row">
                <h2 id="agent-title">{t('console.title')}</h2>
                <span
                  role="status"
                  className={`console-status-pill ${status === 'ready' ? 'console-connected' : 'console-reconnecting'}`}
                >
                  {status === 'ready'
                    ? t('console.connected')
                    : t('console.reconnecting')}
                </span>
              </div>
              <p>{t('console.description')}</p>
            </div>
            <div className="console-heading-actions">
              <ConsoleHelp />
              <Button className="console-exit-btn" onClick={clearGatewayToken}>
                {t('console.exitAdmin')}
              </Button>
              <Button aria-label={t('console.closeAria')} onClick={onClose}>
                {t('console.close')}
              </Button>
            </div>
          </div>
          {gatewayFailure && (
            <p className="agent-error" role="alert">
              {gatewayFailure}
            </p>
          )}
          <nav className="agent-tabs" aria-label={t('console.tabsAria')}>
            <button
              aria-pressed={tab === 'characters'}
              onClick={() => {
                setTab('characters');
                setError('');
                setNotice('');
              }}
            >
              {t('console.tabs.characters')}
            </button>
            <button
              aria-pressed={tab === 'plans'}
              onClick={() => setTab('plans')}
            >
              {t('console.tabs.plans')}
            </button>
            <button
              aria-pressed={tab === 'providers'}
              onClick={() => {
                setTab('providers');
                editProvider(selected ?? providers[0]);
              }}
            >
              {t('console.tabs.providers')}
            </button>
            <button
              aria-pressed={tab === 'voice'}
              onClick={() => setTab('voice')}
            >
              {t('console.tabs.voice')}
            </button>
            <button aria-pressed={tab === 'asr'} onClick={() => setTab('asr')}>
              {t('console.tabs.asr')}
            </button>
            <button
              aria-pressed={tab === 'asrInput'}
              onClick={() => setTab('asrInput')}
            >
              {t('console.tabs.asrInput')}
            </button>
          </nav>
        </div>

        <div className="agent-body" ref={body}>
          <fieldset
            disabled={status !== 'ready'}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <div hidden={tab !== 'plans'}>
              <TaskPlans
                characters={controller.jobs}
                active={open && status === 'ready' && tab === 'plans'}
                disabled={status !== 'ready'}
              />
            </div>
            <div className="console-voice" hidden={tab !== 'voice'}>
              <VoiceServices
                services={controller.voiceServices}
                onChange={controller.setVoiceServices}
                active={open && status === 'ready' && tab === 'voice'}
              />
            </div>
            <div className="console-voice" hidden={tab !== 'asr'}>
              <SpeechRecognitionPanel
                connection={connection}
                active={open && status === 'ready' && tab === 'asr'}
              />
            </div>
            <div hidden={tab !== 'asrInput'}>
              <AsrInputSettings
                active={open && status === 'ready' && tab === 'asrInput'}
              />
            </div>
            <div
              hidden={
                tab === 'voice' ||
                tab === 'asr' ||
                tab === 'asrInput' ||
                tab === 'plans'
              }
            >
              {tab === 'providers' ? (
                <ProviderEditor {...controller} />
              ) : (
                <AICharacters
                  {...controller}
                  active={open && status === 'ready' && tab === 'characters'}
                />
              )}
            </div>
          </fieldset>
        </div>

        {(notice || error) && (
          <div className="console-toast-wrapper" aria-live="polite">
            {notice && (
              <div className="console-toast console-toast-notice" role="status">
                <CheckCircle2 size={16} className="console-toast-icon" />
                <span className="console-toast-message">{notice}</span>
                <button
                  type="button"
                  className="console-toast-dismiss"
                  onClick={() => setNotice('')}
                  aria-label={t('common.close')}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            {error && (
              <div className="console-toast console-toast-error" role="alert">
                <AlertCircle size={16} className="console-toast-icon" />
                <span className="console-toast-message">{error}</span>
                <button
                  type="button"
                  className="console-toast-dismiss"
                  onClick={() => setError('')}
                  aria-label={t('common.close')}
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </ConsoleFeedbackContext.Provider>
  );
}
