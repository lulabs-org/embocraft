import { useI18n } from '../../i18n';

export function ConsoleHelp() {
  const { t } = useI18n();

  return (
    <>
      <button
        type="button"
        className="console-help-trigger"
        aria-label={t('console.help.triggerTitle')}
        title={t('console.help.triggerTitle')}
        popoverTarget="console-help"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4" />
          <circle cx="12" cy="16.5" r=".8" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <section
        id="console-help"
        className="console-help"
        popover="auto"
        aria-labelledby="console-help-title"
      >
        <div className="console-help-heading">
          <h3 id="console-help-title">{t('console.help.title')}</h3>
          <button
            type="button"
            aria-label={t('common.close')}
            popoverTarget="console-help"
            popoverTargetAction="hide"
          >
            {t('console.help.close')}
          </button>
        </div>
        <h4>{t('console.help.charactersTitle')}</h4>
        <p>{t('console.help.charactersDesc')}</p>
        <h4>{t('console.help.plansTitle')}</h4>
        <p>{t('console.help.plansDesc')}</p>
        <h4>{t('console.help.providersTitle')}</h4>
        <p>{t('console.help.providersDesc')}</p>
        <h4>{t('console.help.ttsTitle')}</h4>
        <p>{t('console.help.ttsDesc')}</p>
        <h4>{t('console.help.asrTitle')}</h4>
        <p>{t('console.help.asrDesc')}</p>
      </section>
    </>
  );
}
