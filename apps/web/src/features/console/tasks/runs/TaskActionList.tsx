import { useId, useState } from 'react';
import type { TaskRunAction } from '@voxel/shared';
import { useI18n } from '../../../../i18n/context';
import { presentAction } from '../presentation/action-presentation';

export function TaskActionList({
  actions = [],
  report,
  timeZone,
}: {
  actions: TaskRunAction[] | undefined;
  report?: string;
  timeZone: string;
}) {
  const { t, language } = useI18n();
  const formatTime = new Intl.DateTimeFormat(
    language === 'en' ? 'en-US' : 'zh-CN',
    {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    },
  );
  // The ledger is append-only in execution order; preserve original record numbers.
  const newestFirst = actions
    .map((action, index) => ({ action, index }))
    .reverse();
  return (
    <details className="task-action-records">
      <summary>
        {t('console.plans.actualActions')}{' '}
        <span className="task-action-count">
          {t('console.plans.actionCount', { count: actions.length })}
        </span>
      </summary>
      {actions.length ? (
        <ol className="task-action-list">
          {newestFirst.map(({ action, index }) => {
            const view = presentAction(action);
            const feedback = view.feedback?.trim();
            return (
              <li
                key={`${action.batchId ?? action.call}:${action.index}`}
                className="task-action-item"
              >
                <span className="task-action-number" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="task-action-content">
                  <div className="task-action-heading">
                    <strong>{view.title}</strong>
                    <span className={`task-action-status is-${view.tone}`}>
                      {view.status}
                    </span>
                    {action.startedAt != null &&
                    Number.isFinite(action.startedAt) ? (
                      <time
                        className="task-action-time"
                        dateTime={new Date(action.startedAt).toISOString()}
                        title={timeZone}
                      >
                        {formatTime.format(action.startedAt)}
                      </time>
                    ) : (
                      <span className="task-action-time">
                        {t(
                          action.status === 'pending'
                            ? 'console.plans.actionNotStarted'
                            : 'console.plans.actionTimeUnknown',
                        )}
                      </span>
                    )}
                  </div>
                  {(view.summary ||
                    (feedback && feedback !== report?.trim())) && (
                    <p className="task-action-summary">
                      {[
                        view.summary,
                        feedback !== report?.trim() &&
                        feedback !== view.summary?.trim()
                          ? feedback
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                  <ActionRawData
                    label={t('console.plans.rawActionData')}
                    raw={view.raw}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="task-action-empty">{t('console.plans.noActions')}</p>
      )}
    </details>
  );
}

function ActionRawData({ label, raw }: { label: string; raw: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        className="task-action-raw-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {label}
      </button>
      <pre id={id} className="task-action-raw-data" hidden={!open}>
        {raw}
      </pre>
    </>
  );
}
