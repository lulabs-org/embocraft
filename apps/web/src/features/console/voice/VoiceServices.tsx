import { ConsoleFeedbackRelay } from '../../../components/ui/ConsoleFeedbackRelay';
import type {
  VoiceServiceDraft,
  VoiceServiceType,
  VoiceServiceView,
} from '@voxel/shared';
import { DEFAULT_PIPER_MODEL, PIPER_MODELS } from '@voxel/shared';
import { useEffect, useState } from 'react';
import { useI18n } from '../../../i18n';
import { voiceApi } from './api';
import { BrowserVoiceSelect } from './BrowserVoiceSelect';
import { PiperModelSelect } from './PiperModelSelect';
import { VoicePreview } from './VoicePreview';

const fresh = (type: VoiceServiceType = 'piper'): VoiceServiceDraft => ({
  name: '',
  type,
  apiKey: '',
  speed: 1,
  baseUrl:
    type === 'bailian'
      ? 'https://dashscope.aliyuncs.com/api/v1'
      : type === 'compatible'
        ? 'https://api.openai.com/v1'
        : '',
  model:
    type === 'bailian'
      ? 'qwen3-tts-flash'
      : type === 'compatible'
        ? 'tts-1'
        : type === 'piper'
          ? DEFAULT_PIPER_MODEL
          : '',
  voice: type === 'bailian' ? 'Cherry' : type === 'compatible' ? 'alloy' : '',
});

export function VoiceServices({
  services,
  onChange,
  active,
}: {
  services: VoiceServiceView[];
  onChange: (list: VoiceServiceView[]) => void;
  active: boolean;
}) {
  const { t } = useI18n();

  const labels: Record<VoiceServiceType, string> = {
    piper: t('console.voice.typePiper'),
    browser: t('console.voice.typeBrowser'),
    bailian: t('console.voice.typeBailian'),
    compatible: t('console.voice.typeCompatible'),
  };

  const voiceLabel = (service: VoiceServiceView) =>
    service.type === 'piper'
      ? PIPER_MODELS.find((model) => model.id === service.model)?.name ||
        service.model
      : service.voice || t('console.voice.autoSelectVoice');

  const [selected, setSelected] = useState<string | null | undefined>();
  const [draft, setDraft] = useState(fresh);
  const [dirty, setDirty] = useState(false);
  const [editingKey, setEditingKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const saved = services.find((s) => s.id === selected);
  const canKeepKey = (() => {
    if (!saved?.hasApiKey || saved.type !== draft.type) return false;
    try {
      return (
        new URL(draft.baseUrl.trim()).href.replace(/\/$/, '') === saved.baseUrl
      );
    } catch {
      return false;
    }
  })();
  const choose = (service?: VoiceServiceView) => {
    setSelected(service?.id ?? null);
    setEditingKey(false);
    setDraft(service ? { ...service, apiKey: '' } : fresh());
    setDirty(!service);
    setNotice('');
    setError('');
  };
  useEffect(() => {
    if (selected === undefined && services.length) choose(services[0]);
  }, [services, selected]);
  const change = (patch: Partial<VoiceServiceDraft>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
    setNotice('');
    setError('');
  };
  const save = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await voiceApi.saveVoiceService(
        draft,
        selected ?? undefined,
      );
      onChange(
        selected
          ? services.map((s) => (s.id === selected ? value : s))
          : [...services, value],
      );
      choose(value);
      setNotice(t('console.voice.saveSuccessNotice'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('console.voice.saveFailed'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await voiceApi.deleteVoiceService(selected);
      const next = services.filter((s) => s.id !== selected);
      onChange(next);
      choose(next[0]);
      setNotice(t('console.voice.deleteSuccessNotice'));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t('console.voice.deleteFailed'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="voice-services-layout console-columns">
      <aside
        className="console-sidebar"
        aria-label={t('console.voice.listAria')}
      >
        <button
          className="primary console-sidebar-add"
          disabled={busy}
          onClick={() => choose()}
        >
          {t('console.voice.createButton')}
        </button>
        <div className="console-sidebar-items">
          {services.map((service) => (
            <button
              className="console-sidebar-item"
              key={service.id}
              aria-pressed={selected === service.id}
              disabled={busy}
              onClick={() => choose(service)}
            >
              <span className="console-sidebar-copy">
                <strong title={service.name}>{service.name}</strong>
                <small
                  title={`${labels[service.type]} · ${voiceLabel(service)}`}
                >
                  {labels[service.type]}
                  <br />
                  {voiceLabel(service)}
                </small>
              </span>
            </button>
          ))}
        </div>
        <p className="console-sidebar-note">{t('console.voice.reuseNote')}</p>
      </aside>
      <div className="agent-form console-panel">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="console-panel-heading">
            <h3>
              {selected
                ? t('console.voice.headingEdit')
                : t('console.voice.headingAdd')}
            </h3>
            <p>{t('console.voice.headingDesc')}</p>
          </div>
          <ConsoleFeedbackRelay error={error} notice={notice} active={active} />
          <fieldset disabled={busy}>
            <label>
              {t('console.voice.nameLabel')}
              <input
                required
                maxLength={50}
                placeholder={t('console.voice.namePlaceholder')}
                value={draft.name}
                onChange={(e) => change({ name: e.target.value })}
              />
            </label>
            <label>
              {t('console.voice.serviceTypeLabel')}
              <select
                value={draft.type}
                onChange={(e) => {
                  setDraft({
                    ...fresh(e.target.value as VoiceServiceType),
                    name: draft.name,
                  });
                  setDirty(true);
                }}
              >
                {Object.entries(labels).map(([type, label]) => (
                  <option key={type} value={type}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {draft.type !== 'piper' && draft.type !== 'browser' && (
              <>
                <label>
                  API Base URL
                  {draft.type === 'bailian' ? (
                    <select
                      value={draft.baseUrl}
                      onChange={(e) => change({ baseUrl: e.target.value })}
                    >
                      <option value="https://dashscope.aliyuncs.com/api/v1">
                        {t('console.voice.regionBeijing')}
                      </option>
                      <option value="https://dashscope-intl.aliyuncs.com/api/v1">
                        {t('console.voice.regionSingapore')}
                      </option>
                    </select>
                  ) : (
                    <input
                      type="url"
                      required
                      value={draft.baseUrl}
                      onChange={(e) => change({ baseUrl: e.target.value })}
                    />
                  )}
                </label>
                <div className="voice-key-field">
                  <span className="voice-key-label">API Key</span>
                  {canKeepKey && !editingKey ? (
                    <div className="voice-key-saved">
                      <span role="status">
                        {t('console.voice.keyConfiguredStatus')}
                      </span>
                      <button type="button" onClick={() => setEditingKey(true)}>
                        {t('console.voice.changeKey')}
                      </button>
                    </div>
                  ) : (
                    <div className="voice-key-input">
                      <input
                        aria-label="API Key"
                        type="password"
                        autoComplete="new-password"
                        value={draft.apiKey}
                        placeholder={
                          canKeepKey
                            ? t('console.voice.keyPlaceholderNew')
                            : t('console.voice.keyPlaceholderEmpty')
                        }
                        onChange={(e) => change({ apiKey: e.target.value })}
                      />
                      {canKeepKey && (
                        <button
                          type="button"
                          onClick={() => {
                            if (draft.apiKey) change({ apiKey: '' });
                            setEditingKey(false);
                          }}
                        >
                          {t('console.voice.cancelChangeKey')}
                        </button>
                      )}
                    </div>
                  )}
                  <small>
                    {canKeepKey
                      ? editingKey
                        ? t('console.voice.keyLeaveBlankHint')
                        : t('console.voice.keySavedServerSide')
                      : saved?.hasApiKey
                        ? t('console.voice.keyChangedWarning')
                        : t('console.voice.keyServerOnly')}
                  </small>
                </div>
                <label>
                  {t('console.voice.voiceModel')}
                  <input
                    required
                    maxLength={128}
                    value={draft.model}
                    onChange={(e) => change({ model: e.target.value })}
                  />
                </label>
              </>
            )}
            {draft.type === 'browser' ? (
              <BrowserVoiceSelect
                value={draft.voice}
                language={draft.voiceLanguage}
                onChange={(voice, voiceLanguage) =>
                  change({ voice, voiceLanguage })
                }
                active={active}
              />
            ) : draft.type === 'piper' ? (
              <PiperModelSelect
                value={draft.model}
                onChange={(model) => change({ model })}
              />
            ) : (
              <label>
                {t('console.voice.voiceLabel')}
                <input
                  required
                  maxLength={100}
                  value={draft.voice}
                  placeholder={t('console.voice.voicePlaceholder')}
                  onChange={(e) => change({ voice: e.target.value })}
                />
              </label>
            )}
            {draft.type !== 'bailian' && (
              <label>
                {t('console.voice.speedLabel')}
                <input
                  type="number"
                  required
                  min={0.5}
                  max={2}
                  step={0.1}
                  value={Number.isNaN(draft.speed) ? '' : draft.speed}
                  onChange={(e) => change({ speed: e.target.valueAsNumber })}
                />
              </label>
            )}
            {draft.type === 'browser' && (
              <p className="agent-hint">{t('console.voice.hintBrowser')}</p>
            )}
            {draft.type === 'piper' && (
              <p className="agent-hint">{t('console.voice.hintPiper')}</p>
            )}
            {draft.type === 'bailian' && (
              <p className="agent-hint">{t('console.voice.hintBailian')}</p>
            )}
            <div className="voice-service-actions console-form-actions">
              <button className="primary" disabled={!dirty}>
                {busy
                  ? t('console.voice.saving')
                  : t('console.voice.saveService')}
              </button>
              {selected && (
                <button type="button" onClick={() => void remove()}>
                  {t('console.voice.deleteService')}
                </button>
              )}
            </div>
          </fieldset>
        </form>
        {dirty && (
          <p className="agent-hint">{t('console.voice.previewDirtyHint')}</p>
        )}
        <VoicePreview
          serviceId={selected ?? undefined}
          service={saved}
          active={active}
          disabled={dirty || busy}
        />
      </div>
    </div>
  );
}
