import { useI18n } from '../../i18n';
import { randomPlayerName } from './random-player-name';

interface LobbyCardProps {
  name: string;
  error?: string;
  onNameChange: (name: string) => void;
  onJoin: () => void;
  onCreateAgent: () => void;
  onPreloadConsole?: () => void;
}

export function LobbyCard({
  name,
  error,
  onNameChange,
  onJoin,
  onCreateAgent,
  onPreloadConsole,
}: LobbyCardProps) {
  const { t, language } = useI18n();

  return (
    <div className="join">
      <div className="eyebrow">{t('lobby.eyebrow')}</div>
      <h2>
        {t('lobby.titleLine1')}
        <br />
        {t('lobby.titleLine2')}
      </h2>
      <p className="lobby-description">
        {t('lobby.descriptionLine1')}
        <br />
        {t('lobby.descriptionLine2')}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onJoin();
        }}
      >
        <label htmlFor="name">{t('lobby.playerName')}</label>
        <div className="player-name-field">
          <input
            id="name"
            value={name}
            maxLength={24}
            placeholder={t('lobby.playerNamePlaceholder')}
            pattern={'.*\\S.*'}
            aria-invalid={!!error}
            aria-describedby={error ? 'name-error' : undefined}
            onChange={(e) => onNameChange(e.target.value)}
            required
          />
          <button
            className="random-player-name"
            type="button"
            onClick={() => onNameChange(randomPlayerName(language, name))}
          >
            {t('lobby.randomName')}
          </button>
        </div>
        {error && (
          <p id="name-error" className="agent-error" role="alert">
            {error}
          </p>
        )}
        <button>{t('lobby.enterWorld')}</button>
      </form>
      <button
        className="join-agents"
        onClick={onCreateAgent}
        onPointerEnter={onPreloadConsole}
        onFocus={onPreloadConsole}
      >
        {t('lobby.createAgent')}
      </button>
      <small>{t('lobby.footer')}</small>
    </div>
  );
}
