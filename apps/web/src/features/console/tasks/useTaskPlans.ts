import { useEffect, useRef, useState } from 'react';
import type {
  AICharacterSummary,
  TaskPlan,
  TaskPlanDraft,
  TaskLimits,
  TaskRun,
} from '@voxel/shared';
import type { PublicPlanView, PlanQueryFilter } from '@voxel/shared/management';
import { useI18n } from '../../../i18n/context';
import { refreshOnGatewayChange } from '../../../network/gateway';
import { tasksApi, type PlanPage } from './api';
import { displayedTaskIdentity, controlTaskRun } from '../execution/api';
export function useTaskPlans({
  characters,
  active,
  disabled,
}: {
  characters: AICharacterSummary[];
  active: boolean;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [filters, setFilters] = useState<PlanQueryFilter>({});
  const [page, setPage] = useState<PlanPage>({ items: [], total: 0 });
  const [selected, setSelected] = useState<string>();
  const [plan, setPlan] = useState<PublicPlanView>();
  const [creating, setCreating] = useState(false);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [nextRunPage, setNextRunPage] = useState<number>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [readError, setReadError] = useState(''),
    [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [detailTab, setDetailTab] = useState<'details' | 'active' | 'history'>(
    'details',
  );
  const historyDepth = useRef(20);
  const mutation = useRef(false);

  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    const read = async () => {
      try {
        const list = await tasksApi.list(filters, abort.signal);
        const current = selected
          ? await tasksApi.get(selected, abort.signal)
          : undefined;
        const history: TaskRun[] = [];
        let next: number | undefined;
        if (selected) {
          let offset = 0;
          do {
            const result = await tasksApi.runs(selected, offset, abort.signal);
            history.push(...result.active, ...result.items);
            next = result.nextOffset;
            if (next === undefined || next >= historyDepth.current) break;
            offset = next;
          } while (!abort.signal.aborted);
        }
        if (abort.signal.aborted) return;
        setReadError('');
        setPage(list);
        setPlan(current);
        setRuns([...new Map(history.map((r) => [r.id, r])).values()]);
        setNextRunPage(next);
        setLoading(false);
      } catch (e) {
        if (!abort.signal.aborted) {
          setReadError(
            e instanceof Error ? e.message : t('console.plans.noMatchPlans'),
          );
          setLoading(false);
        }
      }
    };
    const stop = refreshOnGatewayChange(read, { resource: 'plans' });
    return () => {
      abort.abort();
      stop();
    };
  }, [active, selected, filters, revision, t]);

  const mutate = async (action: () => Promise<unknown>) => {
    if (mutation.current || disabled) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      setRevision((v) => v + 1);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t('console.characters.operationFailed'),
      );
      throw e;
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  };

  const changeFilter = (value: PlanQueryFilter) => {
    setFilters((old) => ({ ...old, ...value, offset: 0 }));
  };

  const job = characters.find((a) => a.id === plan?.characterId);
  const blocked = !job
    ? t('console.plans.reassignTitle')
    : !job.sessionId
      ? t('console.characters.filterOffline')
      : ['joining', 'stopping'].includes(job.status)
        ? t('console.characters.bannerTransitioning')
        : '';
  const locked = busy || disabled;

  const control = async (
    operation: string,
    value: Record<string, unknown> = {},
  ) => {
    if (!plan) return;
    try {
      await mutate(() =>
        tasksApi.control(
          plan,
          operation,
          value,
          operation === 'run' ? displayedTaskIdentity(job) : undefined,
        ),
      );
    } catch {
      /* displayed */
    }
  };

  const runControl = async (
    run: TaskRun,
    operation: 'pause' | 'resume' | 'cancel',
    limits?: TaskLimits,
  ) => {
    const owner = characters.find((a) => a.id === run.characterId);
    try {
      await mutate(() =>
        controlTaskRun(
          run.id,
          operation,
          { ...limits },
          displayedTaskIdentity(owner),
        ),
      );
    } catch {
      /* displayed */
    }
  };

  const openPlan = (id: string) => {
    setSelected(id);
    setDetailTab('details');
    setRevision((v) => v + 1);
    setPlan(undefined);
    setRuns([]);
    historyDepth.current = 20;
    setError('');
  };

  // 进入「任务计划」页签后默认选中列表第一个任务，避免右侧详情空白。
  useEffect(() => {
    if (active && !selected && page.items.length) openPlan(page.items[0].id);
  }, [active, selected, page.items]);

  const createPlan = async (
    draft: TaskPlanDraft,
    requestId: string,
    characterId: string,
  ) => {
    try {
      let saved: TaskPlan | undefined;
      await mutate(async () => {
        saved = await tasksApi.save(characterId, draft, undefined, requestId);
      });
      if (saved) {
        setCreating(false);
        openPlan(saved.id);
      }
    } catch {
      /* retain draft */
    }
  };
  const savePlan = async (
    draft: TaskPlanDraft,
    requestId: string,
    characterId: string,
  ) => {
    if (!plan) return;
    try {
      await mutate(() => tasksApi.save(characterId, draft, plan, requestId));
    } catch {
      /* retain draft */
    }
  };
  const previousPage = () =>
    setFilters((f) => ({ ...f, offset: Math.max(0, (f.offset ?? 0) - 20) }));
  const nextPage = () => setFilters((f) => ({ ...f, offset: page.nextOffset }));
  const loadOlderRecords = () => {
    historyDepth.current += 20;
    setRevision((v) => v + 1);
  };
  return {
    filters,
    page,
    selected,
    plan,
    creating,
    runs,
    nextRunPage,
    loading,
    error: error || readError,
    locked,
    blocked,
    detailTab,
    setDetailTab,
    changeFilter,
    openPlan,
    control,
    runControl,
    createPlan,
    savePlan,
    previousPage,
    nextPage,
    loadOlderRecords,
    startCreating: () => setCreating(true),
    cancelCreating: () => setCreating(false),
  };
}
export type TaskPlansController = ReturnType<typeof useTaskPlans>;
