import { useEffect, useState, type FormEvent } from 'react';
import {
  LIVE_VOICE_DEFAULTS,
  type LiveVoiceDraft,
  type LiveVoiceProvider,
  type LiveVoiceView,
} from '@voxel/shared';
import { useI18n } from '../../../i18n/context';
import { consoleFetch } from '../request';

const fresh = (provider: LiveVoiceProvider = 'openai'): LiveVoiceDraft => ({
  provider,
  name: '',
  ...LIVE_VOICE_DEFAULTS[provider],
  apiKey: '',
});
export function LiveVoiceServices({
  services,
  onChange,
}: {
  services: LiveVoiceView[];
  onChange: (values: LiveVoiceView[]) => void;
}) {
  const { t } = useI18n();
  const [id, setId] = useState('new');
  const [draft, setDraft] = useState<LiveVoiceDraft>(() => fresh());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saved = services.find((item) => item.id === id);
  useEffect(() => {
    if (id !== 'new' && !saved) {
      setId('new');
      setDraft(fresh());
    }
  }, [id, saved]);
  const choose = (service?: LiveVoiceView) => {
    setId(service?.id ?? 'new');
    setDraft(service ? { ...service, apiKey: '' } : fresh());
    setError('');
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await consoleFetch<LiveVoiceView>(
        `/voice/live/services${saved ? `/${encodeURIComponent(saved.id)}` : ''}`,
        { method: saved ? 'PUT' : 'POST', body: draft },
      );
      onChange(
        services.some((item) => item.id === result.id)
          ? services.map((item) => (item.id === result.id ? result : item))
          : [...services, result],
      );
      setId(result.id);
      setDraft({ ...result, apiKey: '' });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('console.liveVoice.error'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!saved || busy) return;
    setBusy(true);
    setError('');
    try {
      await consoleFetch(
        `/voice/live/services/${encodeURIComponent(saved.id)}`,
        { method: 'DELETE' },
      );
      onChange(services.filter((item) => item.id !== saved.id));
      choose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('console.liveVoice.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="voice-services-layout console-columns"
      aria-label={t('console.liveVoice.title')}
    >
      <aside className="console-sidebar">
        <button
          className="primary console-sidebar-add"
          type="button"
          onClick={() => choose()}
          disabled={busy}
        >
          {t('console.liveVoice.add')}
        </button>
        <div className="console-sidebar-items">
          {services.map((item) => (
            <button
              key={item.id}
              type="button"
              className="console-sidebar-item"
              aria-pressed={id === item.id}
              onClick={() => choose(item)}
              disabled={busy}
            >
              <span className="console-sidebar-copy">
                <strong>{item.name}</strong>
                <small>
                  {item.provider === 'openai' ? 'OpenAI' : 'Gemini'} ·{' '}
                  {item.model}
                </small>
              </span>
            </button>
          ))}
        </div>
      </aside>
      <form
        className="agent-form console-panel"
        onSubmit={(event) => void save(event)}
      >
        <div className="console-panel-heading">
          <h3>
            {saved ? t('console.liveVoice.edit') : t('console.liveVoice.add')}
          </h3>
          <p>{t('console.liveVoice.description')}</p>
        </div>
        <fieldset disabled={busy}>
          <label>
            {t('console.liveVoice.name')}
            <input
              required
              maxLength={50}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            {t('console.liveVoice.provider')}
            <select
              value={draft.provider}
              disabled={!!saved}
              onChange={(e) => {
                const provider = e.target.value as LiveVoiceProvider;
                setDraft({ ...fresh(provider), name: draft.name });
              }}
            >
              <option value="openai">OpenAI GPT-Live</option>
              <option value="gemini">Gemini Live</option>
            </select>
          </label>
          <label>
            {t('console.liveVoice.model')}
            <input
              required
              value={draft.model}
              maxLength={128}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            />
          </label>
          <label>
            {t('console.liveVoice.voice')}
            <input
              required
              value={draft.voice}
              maxLength={80}
              onChange={(e) => setDraft({ ...draft, voice: e.target.value })}
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              autoComplete="new-password"
              value={draft.apiKey}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              placeholder={
                saved?.hasApiKey
                  ? t('console.voice.keyPlaceholderNew')
                  : t('console.voice.keyPlaceholderEmpty')
              }
            />
          </label>
          <small>
            {saved?.hasApiKey
              ? t('console.voice.keyLeaveBlankHint')
              : t('console.voice.keyServerOnly')}
          </small>
          {error && (
            <p className="agent-error" role="alert">
              {error}
            </p>
          )}
          <div className="voice-service-actions console-form-actions">
            <button className="primary" type="submit">
              {t('console.liveVoice.save')}
            </button>
            {saved && (
              <button type="button" onClick={() => void remove()}>
                {t('console.liveVoice.delete')}
              </button>
            )}
          </div>
        </fieldset>
      </form>
    </section>
  );
}
