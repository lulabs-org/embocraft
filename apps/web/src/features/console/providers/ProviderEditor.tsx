import { ConsoleFeedbackRelay } from '../../../components/ui/ConsoleFeedbackRelay';
import type { AICharacterSettings, ProviderType } from '@voxel/shared';
import { useI18n } from '../../../i18n/context';
import type { ConsoleController } from '../useConsoleController';
import { freshProvider } from './model';

type Props = Pick<
  ConsoleController,
  | 'providers'
  | 'editing'
  | 'draft'
  | 'setDraft'
  | 'busy'
  | 'editingProvider'
  | 'editProvider'
  | 'saveProvider'
  | 'removeProvider'
  | 'models'
  | 'loadingModels'
  | 'modelFeedback'
  | 'readModels'
>;
export function ProviderEditor({
  providers,
  editing,
  draft,
  setDraft,
  busy,
  editingProvider,
  editProvider,
  saveProvider,
  removeProvider,
  models,
  loadingModels,
  modelFeedback,
  readModels,
}: Props) {
  const { t } = useI18n();
  const savedConnection =
    editingProvider &&
    editingProvider.type === draft.type &&
    editingProvider.baseUrl === draft.baseUrl.trim() &&
    !draft.apiKey;
  const canReadModels =
    savedConnection &&
    (editingProvider.type === 'ollama' || editingProvider.hasApiKey);
  return (
    <div className="agent-columns console-columns">
      <aside
        className="console-sidebar"
        aria-label={t('console.providers.listAria')}
      >
        <div className="console-sidebar-heading">
          <h3>{t('console.providers.title')}</h3>
        </div>
        <button
          className="primary console-sidebar-add"
          onClick={() => editProvider()}
          disabled={busy}
        >
          {t('console.providers.createButton')}
        </button>
        <div className="console-sidebar-items">
          {providers.map((p) => (
            <button
              className="console-sidebar-item"
              key={p.id}
              aria-pressed={editing === p.id}
              onClick={() => editProvider(p)}
              disabled={busy}
            >
              <span className="console-sidebar-copy">
                <strong title={p.name}>{p.name}</strong>
                <small>
                  {p.type === 'ollama'
                    ? t('console.providers.noKeyNeeded')
                    : p.hasApiKey
                      ? t('console.providers.keyConfigured')
                      : t('console.providers.noKeyConfigured')}{' '}
                  · {p.defaultModel || t('console.providers.noDefaultModel')}
                </small>
              </span>
            </button>
          ))}
        </div>
        <p className="console-sidebar-note">
          {t('console.providers.keyStorageNote')}
        </p>
      </aside>
      <form onSubmit={saveProvider} className="agent-form console-panel">
        <div className="console-panel-heading">
          <h3>
            {editing
              ? t('console.providers.headingEdit')
              : t('console.providers.headingAdd')}
          </h3>
          <p>{t('console.providers.headingDesc')}</p>
        </div>
        <fieldset disabled={busy || loadingModels}>
          <label>
            {t('console.providers.name')}
            <input
              value={draft.name}
              required
              maxLength={50}
              placeholder={t('console.providers.namePlaceholder')}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            {t('console.providers.providerTypeLabel')}
            <select
              value={draft.type}
              onChange={(e) =>
                setDraft({
                  ...freshProvider(e.target.value as ProviderType),
                  name: draft.name,
                })
              }
            >
              <option value="deepseek">DeepSeek</option>
              <option value="ollama">Ollama</option>
              <option value="compatible">OpenAI</option>
            </select>
          </label>
          <label>
            API Base URL
            <input
              type="url"
              value={draft.type === 'deepseek' ? 'https://api.deepseek.com' : draft.baseUrl}
              required
              disabled={draft.type === 'deepseek'}
              placeholder="https://api.example.com/v1"
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            />
          </label>
          {draft.type === 'deepseek' && (
            <p className="agent-hint">{t('console.providers.deepseekHint')}</p>
          )}
          {draft.type === 'ollama' && (
            <p className="agent-hint">{t('console.providers.ollamaHint')}</p>
          )}
          {draft.type !== 'ollama' && (
            <label>
              API Key
              <input
                type="password"
                autoComplete="new-password"
                value={draft.apiKey}
                placeholder={
                  editingProvider?.hasApiKey
                    ? t('console.providers.keyPlaceholderSaved')
                    : t('console.providers.keyPlaceholderInput')
                }
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              />
            </label>
          )}
          <label>
            {t('console.providers.defaultModelLabel')}
            <input
              list={savedConnection ? 'provider-models' : undefined}
              value={draft.defaultModel}
              maxLength={128}
              placeholder={t('console.providers.defaultModelPlaceholder')}
              onChange={(e) =>
                setDraft({ ...draft, defaultModel: e.target.value })
              }
            />
            <datalist id="provider-models">
              {models.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
          <div className="agent-actions">
            <button
              type="button"
              disabled={!canReadModels}
              onClick={() => editing && void readModels(editing)}
            >
              {loadingModels
                ? t('console.providers.testingConnection')
                : t('console.providers.testConnection')}
            </button>
          </div>
          <ConsoleFeedbackRelay
            error={modelFeedback.error}
            notice={modelFeedback.notice}
          />
          {!canReadModels && (
            <p className="agent-hint">
              {t('console.providers.testConnectionHint')}
            </p>
          )}
          <section className="agents-form-section">
            <h4>{t('console.providers.inferenceSectionTitle')}</h4>
            <p className="agent-hint">
              {t('console.providers.inferenceSectionHint')}
            </p>
            {editingProvider && !editingProvider.inference && (
              <p className="agent-hint">
                {t('console.providers.inferenceNotUnifiedHint')}
              </p>
            )}
            <div className="agent-grid">
              <label>
                {t('console.providers.timeoutLabel')}
                <input
                  type="number"
                  min={1000}
                  max={120000}
                  step={1000}
                  required
                  value={draft.inference.timeoutMs}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      inference: {
                        ...draft.inference,
                        timeoutMs: e.target.valueAsNumber,
                      },
                    })
                  }
                />
              </label>
              <label>
                {t('console.providers.maxTokensLabel')}
                <input
                  type="number"
                  min={128}
                  max={16384}
                  required
                  value={draft.inference.maxTokens}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      inference: {
                        ...draft.inference,
                        maxTokens: e.target.valueAsNumber,
                      },
                    })
                  }
                />
              </label>
            </div>
            {draft.type === 'deepseek' && (
              <div className="agent-grid">
                <label>
                  {t('console.providers.thinkingLabel')}
                  <select
                    value={draft.inference.thinking}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        inference: {
                          ...draft.inference,
                          thinking: e.target
                            .value as AICharacterSettings['thinking'],
                          maxTokens: e.target.value === 'enabled' ? 4096 : 512,
                        },
                      })
                    }
                  >
                    <option value="disabled">
                      {t('console.providers.thinkingDisabled')}
                    </option>
                    <option value="enabled">
                      {t('console.providers.thinkingEnabled')}
                    </option>
                  </select>
                </label>
                <label>
                  {t('console.providers.reasoningEffortLabel')}
                  <select
                    disabled={draft.inference.thinking !== 'enabled'}
                    value={draft.inference.reasoningEffort}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        inference: {
                          ...draft.inference,
                          reasoningEffort: e.target
                            .value as AICharacterSettings['reasoningEffort'],
                        },
                      })
                    }
                  >
                    {['none', 'low', 'high', 'max'].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}

          </section>
          <p className="agent-hint">
            {t('console.providers.openaiCompatibleHint')}
          </p>
          <div className="agent-actions console-form-actions">
            <button className="primary">
              {busy
                ? t('console.characters.saving')
                : t('console.providers.saveProvider')}
            </button>
            {editing && (
              <button type="button" onClick={() => void removeProvider()}>
                {t('console.providers.deleteProvider')}
              </button>
            )}
          </div>
        </fieldset>
      </form>
    </div>
  );
}
