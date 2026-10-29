import { PIPER_MODELS } from '@voxel/shared';
import { useI18n } from '../../../i18n/context';

export function PiperModelSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label>
      {t('console.voice.voiceModel')}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {PIPER_MODELS.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    </label>
  );
}
