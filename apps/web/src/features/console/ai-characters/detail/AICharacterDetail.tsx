import type { PublicAICharacterView } from '@voxel/shared/management';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../../i18n/context';
import type { AICharactersProps } from '../types';
import { AICharacterForm } from '../editor/AICharacterForm';
import { AICharacterLogViewer } from '../activity/AICharacterLogViewer';
import { AICharacterTaskPanel } from '../execution/AICharacterTaskPanel';
import { AICharacterUsagePanel } from '../usage/AICharacterUsagePanel';
import { aiCharacterPresentation } from '../presentation/agent-presentation';

export function AICharacterDetail(
  props: AICharactersProps & {
    job: PublicAICharacterView;
    active: boolean;
    disabled: boolean;
    capacityFull: boolean;
  },
) {
  const { t } = useI18n();
  const {
    job,
    disabled,
    openAgentEditor,
    showAgentForm,
    editingAgent,
    setShowAgentForm,
    setNotice,
    setError,
  } = props;
  const [view, setView] = useState<'settings' | 'task' | 'activity' | 'usage'>(
    'settings',
  );
  const initializedAgent = useRef<string | undefined>(undefined);
  useEffect(() => {
    // Polling updates must not replace an in-progress editor draft.
    if (initializedAgent.current === job.id) return;
    initializedAgent.current = job.id;
    openAgentEditor(job);
    setView('settings');
  }, [job, openAgentEditor]);
  const state = aiCharacterPresentation(job);
  const editing = showAgentForm && editingAgent === job.id;
  return (
    <article
      className="agents-detail"
      aria-label={t('console.characters.workspaceAria', { name: job.name })}
    >
      <div className="agents-detail-heading">
        <div className="agents-identity">
          <span className="agents-avatar" aria-hidden="true">
            {Array.from(job.name)[0]}
          </span>
          <div>
            <h3>{job.name}</h3>
            <p>
              {job.providerName} · {job.model}
            </p>
          </div>
        </div>
        <span className="agents-presence" data-online={state.online}>
          <span className="agents-presence-dot" data-online={state.online} />
          {state.presence}
        </span>
      </div>
      {job.status === 'failed' && (
        <p role="alert" className="agent-error">
          {t('console.characters.lastRunFailed', {
            reason:
              job.task?.reason ||
              t('console.characters.checkConnectionModelHint'),
          })}
        </p>
      )}
      <nav
        className="agents-detail-nav"
        aria-label={t('console.characters.navAria')}
      >
        <button
          aria-pressed={editing}
          disabled={disabled}
          onClick={() => openAgentEditor(job)}
        >
          {t('console.characters.tabSettings')}
        </button>
        <button
          aria-pressed={!editing && view === 'task'}
          onClick={() => {
            setShowAgentForm(false);
            setView('task');
            setError('');
            setNotice('');
          }}
        >
          {t('console.characters.tabTask')}
        </button>
        <button
          aria-pressed={!editing && view === 'activity'}
          onClick={() => {
            setShowAgentForm(false);
            setView('activity');
            setError('');
            setNotice('');
          }}
        >
          {t('console.characters.tabActivity')}
        </button>
        <button
          aria-pressed={!editing && view === 'usage'}
          onClick={() => {
            setShowAgentForm(false);
            setView('usage');
            setError('');
            setNotice('');
          }}
        >
          {t('console.characters.tabUsage')}
        </button>
      </nav>
      {editing ? (
        <AICharacterForm
          {...props}
          disabled={disabled || !state.canEdit}
          leaveDisabled={disabled}
        />
      ) : view === 'usage' ? (
        <AICharacterUsagePanel job={job} />
      ) : view === 'task' ? (
        <AICharacterTaskPanel
          job={job}
          disabled={disabled}
          onUpdated={props.refreshJobs}
        />
      ) : (
        <AICharacterLogViewer job={job} />
      )}
    </article>
  );
}
