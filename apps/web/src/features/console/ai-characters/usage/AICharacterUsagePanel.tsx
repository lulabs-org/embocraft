import type { AICharacterSummary } from '@voxel/shared';
import { useI18n } from '../../../../i18n/context';

export function AICharacterUsagePanel({ job }: { job: AICharacterSummary }) {
  const { t } = useI18n();
  const calls = job.usage?.calls ?? 0;
  const tokens = job.usage?.tokens ?? 0;
  const approx = job.usage?.estimated
    ? t('console.characters.approxPrefix')
    : '';
  const relative = (ts?: number | null) => {
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '—';
    const minutes = Math.floor((Date.now() - ts) / 60000);
    if (minutes < 1) return t('console.characters.justNow');
    if (minutes < 60)
      return t('console.characters.relativeMinutes', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
      return t('console.characters.relativeHours', { count: hours });
    return t('console.characters.relativeDays', {
      count: Math.floor(hours / 24),
    });
  };
  return (
    <section
      className="agents-usage-panel"
      aria-label={t('console.characters.tabUsage')}
    >
      <div className="agents-usage">
        <div>
          <span className="agents-section-label">
            {t('console.characters.totalModelCalls')}
          </span>
          <strong>
            {calls}
            <small>{t('console.characters.turnUnit')}</small>
          </strong>
        </div>
        <div>
          <span className="agents-section-label">
            {t('console.characters.totalTokens')}
          </span>
          <strong>
            {approx}
            {tokens.toLocaleString()}
          </strong>
        </div>
        <div>
          <span className="agents-section-label">
            {t('console.characters.statAvgTokensPerCall')}
          </span>
          <strong>
            {calls > 0
              ? `${t('console.characters.approxPrefix')}${Math.round(tokens / calls).toLocaleString()}`
              : '—'}
          </strong>
        </div>
        <div>
          <span className="agents-section-label">
            {t('console.characters.statLastTaskCalls')}
          </span>
          <strong>
            {job.task ? (
              <>
                {job.task.calls}
                <small>{t('console.characters.turnUnit')}</small>
              </>
            ) : (
              '—'
            )}
          </strong>
        </div>
        <div>
          <span className="agents-section-label">
            {t('console.characters.statCreatedAt')}
          </span>
          <strong>{relative(job.createdAt)}</strong>
        </div>
      </div>
      <p className="agents-usage-note">
        {t('console.characters.usageScopeNote')}
      </p>
    </section>
  );
}
