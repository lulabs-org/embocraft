import { useI18n } from '../../../i18n/context';
import { AudioPlayer } from './AudioPlayer';

/** Local preview only: playing or seeking never uploads the recording. */
export function VoiceDraft({
  src,
  durationMs,
  busy,
  onErrorChange,
}: {
  src: string;
  durationMs: number;
  busy: boolean;
  onErrorChange?: (message: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section
      className="voice-draft"
      aria-label={t('chat.voiceDraftAria')}
      title={t('chat.onlyYouCanHear')}
    >
      <AudioPlayer
        src={src}
        durationMs={durationMs}
        busy={busy}
        onErrorChange={onErrorChange}
        label={t('chat.previewVoice')}
        inline
        playLabel={t('chat.playRecording')}
        pauseLabel={t('chat.pauseRecording')}
      />
    </section>
  );
}
