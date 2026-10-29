import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { audioDuration, audioProgress } from '../../../audio';
import { Play, Pause, LoaderCircle } from 'lucide-react';
import { useI18n } from '../../../i18n/context';

const clock = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export function AudioPlayer({
  src,
  loadSource,
  durationMs,
  busy = false,
  label: customLabel,
  idleLabel: customIdleLabel,
  playLabel: customPlayLabel,
  pauseLabel: customPauseLabel,
  compact = false,
  inline = false,
  onErrorChange,
}: {
  src?: string;
  loadSource?: () => Promise<string>;
  durationMs: number;
  busy?: boolean;
  label?: string;
  idleLabel?: string;
  playLabel?: string;
  pauseLabel?: string;
  compact?: boolean;
  inline?: boolean;
  onErrorChange?: (message: string) => void;
}) {
  const { t } = useI18n();
  const label = customLabel ?? t('chat.voiceMessageDefault');
  const idleLabel = customIdleLabel ?? t('chat.clickToPlay');
  const playLabel = customPlayLabel ?? t('chat.audioPlay');
  const pauseLabel = customPauseLabel ?? t('chat.audioPause');

  const audio = useRef<HTMLAudioElement>(null);
  const operation = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(!!src);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(
    audioDuration(NaN, durationMs / 1000),
  );
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    onErrorChange?.(error);
  }, [error, onErrorChange]);
  useEffect(() => () => onErrorChange?.(''), [onErrorChange]);
  useEffect(() => {
    if (busy) {
      operation.current++;
      audio.current?.pause();
    }
  }, [busy]);
  useEffect(() => {
    const player = audio.current;
    // Keep the counter ref, so cleanup invalidates the latest pending operation.
    const pending = operation;
    return () => {
      pending.current++;
      player?.pause();
    };
  }, []);
  const syncDuration = (player: HTMLAudioElement, finished = false) => {
    const value = audioDuration(
      player.duration,
      duration,
      finished ? player.currentTime : undefined,
    );
    setDuration(value);
    return value;
  };
  const toggle = async () => {
    const player = audio.current;
    if (!player || busy || loading) return;
    if (!player.paused) {
      // An intentional pause may reject a still-pending play() promise.
      operation.current++;
      player.pause();
      return;
    }
    setError('');
    const id = ++operation.current;
    try {
      if (!player.getAttribute('src') && loadSource) {
        setLoading(true);
        const source = await loadSource();
        if (operation.current !== id || audio.current !== player) return;
        player.src = source;
        setLoaded(true);
      }
      if (ended || player.ended || (duration > 0 && current >= duration)) {
        player.currentTime = 0;
        setCurrent(0);
        setEnded(false);
      }
      await player.play();
    } catch (e) {
      if (operation.current === id)
        setError(
          e instanceof Error && e.message
            ? e.message
            : t('chat.playbackErrorRetry'),
        );
    } finally {
      if (audio.current === player) setLoading(false);
    }
  };
  const progress = audioProgress(current, duration, ended);
  const displayedTime = ended ? duration : Math.min(current, duration);
  return (
    <div className="audio-player" role="group" aria-label={label}>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => syncDuration(e.currentTarget)}
        onDurationChange={(e) => syncDuration(e.currentTarget)}
        onTimeUpdate={(e) => {
          syncDuration(e.currentTarget);
          setCurrent(e.currentTarget.currentTime);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={(e) => {
          setCurrent(syncDuration(e.currentTarget, true));
          setEnded(true);
          setPlaying(false);
        }}
        onError={() => {
          setPlaying(false);
          setError(t('chat.audioCorruptedError'));
        }}
      />
      {compact ? (
        <button
          type="button"
          className={`audio-bubble${playing ? ' is-playing' : ''}`}
          style={{ width: `${Math.min(210, 94 + duration * 4)}px` }}
          aria-label={
            loading ? t('chat.loadingVoice') : playing ? pauseLabel : playLabel
          }
          aria-pressed={playing}
          title={playing ? t('chat.clickToPause') : t('chat.clickToPlay')}
          disabled={busy || loading}
          onClick={() => void toggle()}
        >
          <svg
            className="audio-bubble-waves"
            viewBox="0 0 24 24"
            width="21"
            height="21"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 11v2" />
            <path className="wave-middle" d="M10 8a6 6 0 0 1 0 8" />
            <path className="wave-outer" d="M14 5a10 10 0 0 1 0 14" />
          </svg>
          <span>
            {loading
              ? t('chat.loadingShort')
              : `${Math.max(1, Math.ceil(duration))}″`}
          </span>
        </button>
      ) : (
        <div className="audio-player-row">
          <button
            type="button"
            className="audio-play"
            aria-label={
              loading
                ? t('chat.loadingVoice')
                : playing
                  ? pauseLabel
                  : playLabel
            }
            disabled={busy || loading}
            onClick={() => void toggle()}
          >
            {inline ? (
              loading ? (
                <LoaderCircle size={17} strokeWidth={1.7} aria-hidden="true" />
              ) : playing ? (
                <Pause
                  size={17}
                  strokeWidth={1.5}
                  fill="currentColor"
                  aria-hidden="true"
                />
              ) : (
                <Play
                  size={17}
                  strokeWidth={1.5}
                  fill="currentColor"
                  aria-hidden="true"
                />
              )
            ) : (
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="currentColor"
                aria-hidden="true"
              >
                {loading ? (
                  <circle cx="12" cy="12" r="3" />
                ) : playing ? (
                  <path d="M7 5h4v14H7zm6 0h4v14h-4z" />
                ) : (
                  <path d="m9 5 11 7-11 7z" />
                )}
              </svg>
            )}
          </button>
          <div className="audio-track">
            <input
              type="range"
              style={
                { '--voice-progress': `${progress / 10}%` } as CSSProperties
              }
              aria-label={t('chat.progressAria', { label })}
              aria-valuetext={`${clock(displayedTime)} / ${clock(duration)}`}
              min={0}
              max={1000}
              step={1}
              value={progress}
              disabled={busy || loading || !loaded || !duration}
              onChange={(e) => {
                const value = (Number(e.target.value) / 1000) * duration;
                if (audio.current) audio.current.currentTime = value;
                setCurrent(value);
                setEnded(false);
              }}
            />
            <div className="audio-time">
              {inline ? (
                <span className="audio-inline-time">
                  <span>{clock(displayedTime)}</span>
                  <span className="audio-time-divider"> / </span>
                  <span className="audio-time-total">{clock(duration)}</span>
                </span>
              ) : (
                <span>
                  {clock(displayedTime)} / {clock(duration)}
                </span>
              )}
              {!inline && (
                <span>
                  {loading
                    ? t('chat.loadingVoice')
                    : playing
                      ? t('chat.playingStatus')
                      : ended
                        ? t('chat.playEnded')
                        : idleLabel}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
      {error && !onErrorChange && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
