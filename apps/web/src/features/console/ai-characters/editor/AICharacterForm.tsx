import type { AICharacterFormProps } from './types';
import { CharacterBudgetSettings } from './CharacterBudgetSettings';
import { CharacterVoiceSettings } from './CharacterVoiceSettings';
import { CharacterCapabilities } from './CharacterCapabilities';
import { CharacterProfileFields } from './CharacterProfileFields';
import { useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Check,
  Info,
  Loader2,
  Trash2,
  UserCog,
} from 'lucide-react';
import { useI18n } from '../../../../i18n/context';
import { DeleteAICharacterDialog } from '../dialogs/DeleteAICharacterDialog';
import { LeaveAICharacterDialog } from '../dialogs/LeaveAICharacterDialog';
import { aiCharacterPresentation } from '../presentation/agent-presentation';

export function AICharacterForm(props: AICharacterFormProps) {
  const { t } = useI18n();
  const {
    providers,
    voiceServices,
    liveVoiceServices,
    agent,
    setAgent,
    editingAgent,
    setShowAgentForm,
    busy,
    setNotice,
    setError,
    selected,
    chooseProvider,
    saveAgent,
    disabled,
    joinOnCreate,
    setJoinOnCreate,
    jobs,
    deleteAgent,
    error,
    joinAgent,
    stopAgent,
    capacityFull,
    leaveDisabled,
  } = props;

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const current = jobs.find((job) => job.id === editingAgent);
  const running = current && !aiCharacterPresentation(current).canEdit;
  const currentOnline =
    !!current && aiCharacterPresentation(current).occupiesSlot;

  const cancel = () => {
    setShowAgentForm(false);
    setError('');
    setNotice('');
  };

  const validProvider =
    selected &&
    selected.defaultModel.trim() &&
    (selected.type === 'ollama' || selected.hasApiKey);

  return (
    <section className="agents-profile">
      <div className="agents-form-heading">
        <div>
          <h4>
            {editingAgent ? (
              <UserCog size={18} className="agents-heading-icon" />
            ) : (
              <Bot size={18} className="agents-heading-icon" />
            )}
            {editingAgent
              ? t('console.characters.headingEdit')
              : t('console.characters.headingCreate')}
          </h4>
          <p>
            {editingAgent
              ? t('console.characters.headingEditDesc')
              : t('console.characters.headingCreateDesc')}
          </p>
        </div>
        {!editingAgent && (
          <button
            type="button"
            disabled={busy}
            onClick={cancel}
            className="agents-btn-icon"
          >
            <ArrowLeft size={14} />
            {t('common.back')}
          </button>
        )}
      </div>

      {running && (
        <div className="agents-running-banner" role="status">
          <div className="agents-banner-text">
            <Info size={14} className="agents-banner-icon" aria-hidden="true" />
            <p>
              {aiCharacterPresentation(current).transitioning
                ? t('console.characters.bannerTransitioning')
                : t('console.characters.bannerRunning')}
            </p>
          </div>
        </div>
      )}

      <form
        className="agent-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void saveAgent();
        }}
      >
        <fieldset disabled={disabled}>
          <CharacterProfileFields
            agent={agent}
            setAgent={setAgent}
            editingAgent={editingAgent}
            providers={providers}
            selected={selected}
            chooseProvider={chooseProvider}
            validProvider={!!validProvider}
          />
          <CharacterCapabilities agent={agent} setAgent={setAgent} />
          <CharacterVoiceSettings
            agent={agent}
            setAgent={setAgent}
            voiceServices={voiceServices}
            liveVoiceServices={liveVoiceServices}
          />
          <CharacterBudgetSettings agent={agent} setAgent={setAgent} />
          {!editingAgent && (
            <label className="agent-check agents-join-option">
              <input
                type="checkbox"
                checked={joinOnCreate}
                onChange={(e) => setJoinOnCreate(e.target.checked)}
              />
              <span>{t('console.characters.joinOnCreateLabel')}</span>
            </label>
          )}

          <div className="agents-form-footer">
            <div className="agents-footer-left">
              {editingAgent && current && (
                <>
                  <button
                    type="button"
                    className="agents-delete-button agents-btn-icon"
                    disabled={disabled || current.status === 'stopping'}
                    onClick={() => {
                      setError('');
                      setConfirmDelete(true);
                    }}
                  >
                    <Trash2 size={14} />
                    {t('console.characters.deleteButton')}
                  </button>
                  {currentOnline ? (
                    <button
                      type="button"
                      disabled={leaveDisabled || current.status === 'stopping'}
                      onClick={() => {
                        setError('');
                        setConfirmLeave(true);
                      }}
                    >
                      {t('console.characters.offlineButton')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={leaveDisabled || capacityFull}
                      onClick={() => void joinAgent(current)}
                    >
                      {t('console.characters.onlineButton')}
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="agents-footer-right">
              {!editingAgent && (
                <button
                  type="button"
                  onClick={cancel}
                  className="agents-btn-icon"
                >
                  <ArrowLeft size={14} />
                  {t('common.cancel')}
                </button>
              )}
              <button
                type="submit"
                className="primary agents-btn-icon"
                onClick={() => void saveAgent()}
                disabled={
                  !validProvider ||
                  !agent.name.trim() ||
                  (!editingAgent &&
                    joinOnCreate &&
                    props.jobs.filter(
                      (j) => aiCharacterPresentation(j).occupiesSlot,
                    ).length >= 4)
                }
              >
                {busy ? (
                  <>
                    <Loader2 size={14} className="agents-spin" />
                    {t('console.characters.saving')}
                  </>
                ) : (
                  <>
                    <Check size={14} />
                    {editingAgent
                      ? t('console.characters.saveSettings')
                      : joinOnCreate
                        ? t('console.characters.createAndJoin')
                        : t('console.characters.createCharacter')}
                  </>
                )}
              </button>
            </div>
          </div>
        </fieldset>
      </form>

      {confirmDelete && current && (
        <DeleteAICharacterDialog
          name={current.name}
          busy={busy}
          disabled={disabled || current.status === 'stopping'}
          error={error}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void deleteAgent(current)}
        />
      )}
      {confirmLeave && current && (
        <LeaveAICharacterDialog
          name={current.name}
          busy={busy}
          disabled={leaveDisabled || current.status === 'stopping'}
          onCancel={() => setConfirmLeave(false)}
          onConfirm={() => {
            setConfirmLeave(false);
            void stopAgent(current);
          }}
        />
      )}
    </section>
  );
}
