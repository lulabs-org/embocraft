import { LanguageSwitcher } from '../../components/ui/LanguageSwitcher';
import { useI18n } from '../../i18n';

interface GameHeaderProps {
  connectionStatus: string;
  joined: boolean;
  isConsoleOpen: boolean;
  isPlayersOpen: boolean;
  onOpenConsole: () => void;
  onPreloadConsole?: () => void;
  onTogglePlayers: () => void;
  isMenuOpen: boolean;
  onToggleMenu: () => void;
}

export function GameHeader({
  connectionStatus,
  joined,
  isConsoleOpen,
  isPlayersOpen,
  onOpenConsole,
  onPreloadConsole,
  onTogglePlayers,
  isMenuOpen,
  onToggleMenu,
}: GameHeaderProps) {
  const { t } = useI18n();
  const isConnected = connectionStatus === 'connected';

  if (joined) {
    const status = isConnected
      ? t('header.connectedStatus')
      : connectionStatus === 'connecting'
        ? t('header.connectingStatus')
        : t('header.reconnectingStatus');
    return (
      <header className="game-header" data-hud>
        <div
          className="world-identity"
          tabIndex={0}
          title={status}
          aria-label={`${t('header.worldTitle')} · ${status}`}
        >
          <i
            className={isConnected ? 'online' : 'offline'}
            aria-hidden="true"
          />
          <strong>{t('header.worldTitle')}</strong>
          {!isConnected && <span role="status">{status}</span>}
        </div>
        <nav className="hud-navigation" aria-label={t('header.gameFeatures')}>
          <button
            aria-expanded={isPlayersOpen}
            aria-controls="world-panel"
            onClick={onTogglePlayers}
          >
            {t('header.players')}
          </button>
          <button
            aria-haspopup="dialog"
            aria-expanded={isConsoleOpen}
            aria-controls="control-console"
            onClick={onOpenConsole}
            onPointerEnter={onPreloadConsole}
            onFocus={onPreloadConsole}
          >
            {t('header.console')}
          </button>
          <button
            aria-expanded={isMenuOpen}
            aria-controls="game-menu"
            onClick={onToggleMenu}
          >
            {t('header.menu')}
          </button>
        </nav>
      </header>
    );
  }
  return (
    <header>
      <div className="brand">
        <span className="brand-icon">◈</span>
        <div>
          <strong>EMBOCRAFT</strong>
          <small>{t('header.brandSubtitle')}</small>
        </div>
      </div>

      <div className="status">
        <i className={isConnected ? 'online' : ''} />
        {joined ? connectionStatus : t('header.lobby')}{' '}
        <span>{t('header.worldTitle')}</span>
        <button
          className="exit-game"
          aria-haspopup="dialog"
          aria-expanded={isConsoleOpen}
          aria-controls="control-console"
          onClick={onOpenConsole}
          onPointerEnter={onPreloadConsole}
          onFocus={onPreloadConsole}
        >
          {t('header.console')}
        </button>
        <LanguageSwitcher variant="hud" />
        {joined && (
          <nav className="game-panels" aria-label={t('header.gamePanels')}>
            <button
              aria-expanded={isPlayersOpen}
              aria-controls="world-panel"
              onClick={onTogglePlayers}
            >
              {t('header.players')}
            </button>
          </nav>
        )}
      </div>
    </header>
  );
}
