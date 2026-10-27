import { useState } from 'react';
import { useI18n } from '../../../i18n';
import type { AsrChoice } from '../../../audio/services/asr-choice';
import {
  toAsrChoice,
  useAsrSelection,
  useAsrServices,
  type AsrUse,
} from '../../voice';

function InputChoice({
  selection,
  services,
  loaded,
  use,
}: {
  selection: ReturnType<typeof useAsrSelection>;
  services: AsrChoice[];
  loaded: boolean;
  use: AsrUse;
}) {
  const { t } = useI18n();
  return (
    <label className="asr-input-choice">
      <strong>{t('console.asrInput.serviceLabel')}</strong>
      <select
        value={
          services.some((service) => service.id === selection.selected.id)
            ? selection.selected.id
            : ''
        }
        onChange={(e) => {
          const service = services.find(
            (service) => service.id === e.target.value,
          );
          if (service) selection.choose(service);
        }}
      >
        <option value="" disabled>
          {t('console.asrInput.selectPlaceholder')}
        </option>
        {services.map((service) => (
          <option key={service.id} value={service.id}>
            {service.name}
          </option>
        ))}
      </select>
      {loaded &&
        selection.selected.id &&
        !services.some((service) => service.id === selection.selected.id) && (
          <small role="alert">{t('console.asrInput.missing')}</small>
        )}
      {selection.error && <small role="alert">{selection.error}</small>}
      {loaded && !services.length && (
        <small role="status">
          {t(
            use === 'clip'
              ? 'console.asrInput.noWhisperService'
              : 'console.asrInput.noService',
          )}
        </small>
      )}
    </label>
  );
}

export function AsrInputSettings({ active }: { active: boolean }) {
  const { t } = useI18n();
  const [use, setUse] = useState<AsrUse>('spatial');
  const chat = useAsrSelection('chat');
  const spatial = useAsrSelection('spatial');
  const clip = useAsrSelection('clip');
  const selection = { chat, spatial, clip }[use];
  const manager = useAsrServices(active);
  const services = manager.services
    .filter((service) => use !== 'clip' || service.provider === 'whisper')
    .map(toAsrChoice);
  const choices = { chat, spatial, clip };
  return (
    <section
      className="asr-input-settings console-columns"
      aria-label={t('console.asrInput.title')}
    >
      <aside
        className="console-sidebar"
        aria-label={t('console.asrInput.sidebarHeading')}
      >
        <div className="console-sidebar-heading">
          <h3>{t('console.asrInput.sidebarHeading')}</h3>
        </div>
        <div className="console-sidebar-items">
          {(['spatial', 'chat', 'clip'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className="console-sidebar-item"
              aria-pressed={use === item}
              onClick={() => setUse(item)}
            >
              <span className="console-sidebar-copy">
                <strong>{t(`console.asrInput.${item}`)}</strong>
                <small>
                  {choices[item].selected.id
                    ? choices[item].selected.name
                    : t('console.asrInput.selectPlaceholder')}
                </small>
              </span>
            </button>
          ))}
        </div>
        <p className="console-sidebar-note">
          {t('console.asrInput.sidebarNote')}
        </p>
      </aside>
      <div className="agent-form console-panel">
        <div className="console-panel-heading">
          <h3>{t(`console.asrInput.${use}`)}</h3>
          <p>{t(`console.asrInput.${use}Help`)}</p>
        </div>
        {manager.error && (
          <p role="alert" className="agent-error">
            {manager.error}
          </p>
        )}
        <InputChoice
          selection={selection}
          services={services}
          loaded={manager.loaded}
          use={use}
        />
      </div>
    </section>
  );
}
