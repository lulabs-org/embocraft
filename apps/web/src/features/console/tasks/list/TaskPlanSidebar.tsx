import { useI18n } from '../../../../i18n/context';
import type { AICharacterSummary } from '@voxel/shared';
import type { PlanQueryFilter } from '@voxel/shared/management';
import type { TaskPlansController } from '../useTaskPlans';
import {
  timingIcon,
  timingLabel,
  planStatus,
} from '../presentation/plan-presentation';
import { usePlanPresentation } from '../presentation/usePlanPresentation';
export function TaskPlanSidebar({
  controller,
  characters,
}: {
  controller: Pick<
    TaskPlansController,
    | 'page'
    | 'filters'
    | 'selected'
    | 'creating'
    | 'locked'
    | 'loading'
    | 'changeFilter'
    | 'openPlan'
    | 'startCreating'
    | 'previousPage'
    | 'nextPage'
  >;
  characters: AICharacterSummary[];
}) {
  const { t } = useI18n();
  const { bindingName } = usePlanPresentation(characters);
  const {
    page,
    filters,
    selected,
    creating,
    locked,
    loading,
    changeFilter,
    openPlan,
    startCreating,
    previousPage,
    nextPage,
  } = controller;
  return (
    <aside className="console-sidebar" aria-label={t('console.plans.listAria')}>
      <button
        className="primary console-sidebar-add"
        disabled={locked || !characters.length || creating}
        onClick={startCreating}
      >
        {t('console.plans.createButton')}
      </button>
      <p className="console-sidebar-meta">
        {t('console.plans.totalCount', { total: page.total })}
      </p>
      <div className="plans-sidebar-filter">
        <div
          className="plans-state-pills"
          role="group"
          aria-label={t('console.plans.filterStatusAria')}
        >
          {(
            [
              ['', t('console.plans.filterAll')],
              ['enabled', t('console.plans.statusEnabled')],
              ['paused', t('console.plans.statusPaused')],
              ['archived', t('console.plans.statusArchived')],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              aria-pressed={(filters.state ?? '') === value}
              onClick={() =>
                changeFilter({
                  state: (value as PlanQueryFilter['state']) || undefined,
                })
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="console-sidebar-items">
        {page.items.map((p) => (
          <button
            key={p.id}
            className="console-sidebar-item"
            aria-pressed={selected === p.id && !creating}
            disabled={creating}
            onClick={() => openPlan(p.id)}
          >
            <span className="plans-mini-badge" aria-hidden="true">
              {timingIcon(p.timing.kind)}
            </span>
            <span className="console-sidebar-copy">
              <strong title={p.name}>{p.name}</strong>
              <small>
                {bindingName(p)} · {timingLabel(p)}
              </small>
            </span>
            <span
              className="plans-presence-dot"
              data-state={p.state}
              title={planStatus[p.state] || p.state}
              aria-label={planStatus[p.state] || p.state}
            />
          </button>
        ))}
        {!page.items.length && (
          <p className="characters-list-empty">
            {loading
              ? t('console.plans.loadingPlans')
              : t('console.plans.noMatchPlans')}
          </p>
        )}
      </div>
      {(page.total > 20 || !!filters.offset) && (
        <div className="plans-sidebar-pagination">
          <button disabled={!filters.offset} onClick={previousPage}>
            {t('console.plans.prevPage')}
          </button>
          <span className="plans-sidebar-pagination-info">
            {(filters.offset ?? 0) + 1} -{' '}
            {Math.min((filters.offset ?? 0) + 20, page.total)} / {page.total}
          </span>
          <button disabled={page.nextOffset === undefined} onClick={nextPage}>
            {t('console.plans.nextPage')}
          </button>
        </div>
      )}
      <p className="console-sidebar-note">{t('console.plans.cronNote')}</p>
    </aside>
  );
}
