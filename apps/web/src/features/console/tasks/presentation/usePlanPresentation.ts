import type {
  AICharacterSummary,
  TaskPlan,
  TaskPlanSummary,
} from '@voxel/shared';
import { useI18n } from '../../../../i18n/context';
import { planTime } from './plan-presentation';
export function usePlanPresentation(characters: AICharacterSummary[]) {
  const { t } = useI18n();
  const bindingName = (p: TaskPlanSummary) =>
    p.characterId
      ? (characters.find((a) => a.id === p.characterId)?.name ??
        p.characterName ??
        t('console.plans.deletedTag'))
      : p.characterName
        ? `${['completed', 'archived'].includes(p.state) ? '' : `${t('console.plans.reassignTitle')} · `}${p.characterName}${t('console.plans.deletedTag')}`
        : t('console.plans.reassignTitle');

  return { bindingName };
}
export function usePlanStatusText(plan: TaskPlan) {
  const { t } = useI18n();
  const planStatusText = !plan
    ? undefined
    : plan.nextRunAt
      ? t('console.plans.nextRunAt', {
          time: planTime(plan.nextRunAt, plan.timeZone),
        })
      : plan.state === 'completed'
        ? t('console.plans.stateCompletedDesc')
        : plan.state === 'paused'
          ? t('console.plans.statePausedDesc')
          : plan.state === 'archived'
            ? t('console.plans.stateArchivedDesc')
            : t('console.plans.stateReadyDesc');
  return planStatusText;
}
