import { useI18n } from '../../../../i18n/context';
import type { AICharacterFormProps } from './types';
import * as Switch from '@radix-ui/react-switch';
import { Volume2 } from 'lucide-react';
import { aiCharacterPermissions } from '@voxel/shared';
export function CharacterVoiceSettings({
  agent,
  setAgent,
  voiceServices,
  liveVoiceServices = [],
}: Pick<
  AICharacterFormProps,
  'agent' | 'setAgent' | 'voiceServices' | 'liveVoiceServices'
>) {
  const { t } = useI18n();
  const permissions = aiCharacterPermissions(agent);
  return (
    <div className="agents-form-section agents-voice-settings">
      <label className="agents-voice-service">
        {t('console.liveVoice.character')}
        <select
          value={agent.liveVoiceServiceId || ''}
          disabled={!permissions.chat}
          onChange={(event) =>
            setAgent({ ...agent, liveVoiceServiceId: event.target.value })
          }
        >
          <option value="">{t('console.liveVoice.disabled')}</option>
          {liveVoiceServices.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name} · {service.model}
            </option>
          ))}
        </select>
        <small>{t('console.liveVoice.hint')}</small>
      </label>

      <div className="agents-toggle-card">
        <div className="agents-toggle-info">
          <strong>
            <Volume2 size={15} />
            {t('console.characters.voiceReplySectionTitle')}
          </strong>
          <small>{t('console.characters.voiceReplySectionDesc')}</small>
        </div>
        <Switch.Root
          id="voice-reply-switch"
          className="agents-switch-root"
          aria-label={t('console.characters.voiceReplySwitchAria')}
          checked={!!agent.voiceReplies}
          disabled={!permissions.chat || voiceServices.length === 0}
          onCheckedChange={(checked) =>
            setAgent({
              ...agent,
              voiceReplies: checked,
              voiceServiceId: checked
                ? voiceServices.find(
                    (service) => service.id === agent.voiceServiceId,
                  )?.id ||
                  voiceServices[0]?.id ||
                  ''
                : agent.voiceServiceId,
            })
          }
        >
          <Switch.Thumb className="agents-switch-thumb" />
        </Switch.Root>
      </div>

      {!permissions.chat ? (
        <p className="agents-voice-status" role="status">
          {t('console.characters.voiceReplyChatOff')}
        </p>
      ) : voiceServices.length === 0 ? (
        <p className="agents-voice-status" role="status">
          {t('console.characters.voiceReplyNoServices')}
        </p>
      ) : agent.voiceReplies ? (
        <div className="agents-voice-picker">
          <label className="agents-voice-service">
            {t('console.characters.voiceSelectLabel')}
            <select
              value={agent.voiceServiceId || ''}
              required
              onChange={(event) =>
                setAgent({
                  ...agent,
                  voiceServiceId: event.target.value,
                })
              }
            >
              {!voiceServices.some(
                (service) => service.id === agent.voiceServiceId,
              ) && (
                <option value={agent.voiceServiceId || ''} disabled>
                  {t('console.characters.voiceSelectPlaceholder')}
                </option>
              )}
              {voiceServices.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name} ·{' '}
                  {service.voice || t('console.characters.voiceAutoLabel')}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <p className="agents-voice-status">
          {t('console.characters.voiceReplyTextOnly')}
        </p>
      )}
    </div>
  );
}
