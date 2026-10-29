import { useState } from 'react';
import { useI18n } from '../../../../i18n/context';
import type { PublicAICharacterView } from '@voxel/shared/management';
import type { AICharactersController } from '../useAICharactersController';
import { aiCharacterPresentation } from '../presentation/agent-presentation';
type Filter = 'all' | 'online' | 'attention' | 'offline';
export function AICharacterSidebar({
  jobs,
  loadingJobs,
  onlineCount,
  disabled,
  openAgentEditor,
  busy,
  creating,
  current,
  showAgentForm,
  editingAgent,
}: Pick<AICharactersController, 'jobs' | 'showAgentForm' | 'editingAgent'> & {
  busy: boolean;
} & {
  loadingJobs: boolean;
  onlineCount: number;
  disabled: boolean;
  openAgentEditor: (job?: PublicAICharacterView) => void;
  creating: boolean;
  current?: PublicAICharacterView;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const filtered = jobs.filter((job) => {
    const state = aiCharacterPresentation(job);
    return (
      job.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
      (filter === 'all' ||
        (filter === 'online' && state.occupiesSlot) ||
        (filter === 'offline' && !state.occupiesSlot) ||
        (filter === 'attention' && state.attention))
    );
  });
  return (
    <aside
      className="console-sidebar"
      aria-label={t('console.characters.listAria')}
    >
      <button
        className="primary console-sidebar-add"
        disabled={disabled}
        onClick={() => openAgentEditor()}
      >
        ＋ {t('console.characters.create')}
      </button>
      <div
        className="agents-filters"
        role="group"
        aria-label={t('console.characters.filterAria')}
      >
        {(
          [
            ['all', t('console.characters.filterAll')],
            ['online', t('console.characters.filterOnline')],
            ['attention', t('console.characters.filterAttention')],
            ['offline', t('console.characters.filterOffline')],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {jobs.length > 4 && (
        <input
          className="agents-search"
          aria-label={t('console.characters.searchAria')}
          placeholder={t('console.characters.searchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <div className="console-sidebar-items">
        {filtered.map((job) => {
          const state = aiCharacterPresentation(job);
          return (
            <button
              className="console-sidebar-item"
              key={job.id}
              aria-pressed={!creating && current?.id === job.id}
              disabled={busy}
              onClick={() => {
                // 侧栏点击应打开该角色的「设置」；若已在编辑它则保持不动
                // （避免丢弃未保存的修改），绝不回退到「运行记录」视图。
                if (showAgentForm && editingAgent === job.id) return;
                openAgentEditor(job);
              }}
            >
              <span className="agents-mini-avatar" aria-hidden="true">
                {Array.from(job.name)[0]}
              </span>
              <span className="console-sidebar-copy">
                <strong title={job.name}>{job.name}</strong>
                <small>
                  {state.transitioning
                    ? state.presence
                    : state.online
                      ? state.taskLabel
                      : t('console.characters.presenceNotInWorld')}
                </small>
              </span>
              <span
                className="agents-presence-dot"
                data-online={state.online}
                data-attention={state.attention}
                aria-label={state.presence}
              />
            </button>
          );
        })}
        {!filtered.length && (
          <p className="agents-list-empty">
            {loadingJobs
              ? t('console.characters.listLoading')
              : jobs.length
                ? t('console.characters.listNoMatch')
                : t('console.characters.listEmptyCreated')}
          </p>
        )}
      </div>
      <p className="console-sidebar-note">
        {onlineCount >= 4
          ? t('console.characters.capacityFullNote')
          : t('console.characters.offlineRetentionNote')}
      </p>
    </aside>
  );
}
