import { Footprints, Hammer, MessagesSquare } from 'lucide-react';
import { useI18n } from '../../i18n';

interface ControlsHelpProps {
  onClose: () => void;
}

export function ControlsHelp({ onClose }: ControlsHelpProps) {
  const { t } = useI18n();

  return (
    <section
      id="controls-help"
      className="controls-help"
      aria-label={t('hud.controlsHelp')}
    >
      <div className="chat-title">
        <strong>{t('hud.controlsHelp')}</strong>
        <button aria-label={t('hud.closeHelp')} onClick={onClose}>
          ×
        </button>
      </div>
      <section className="controls-help-group">
        <h3>
          <Footprints size={16} aria-hidden="true" />
          {t('hud.controls.movementGroup')}
        </h3>
        <dl>
          <div>
            <dt>
              <span className="controls-help-keys">
                {['W', 'A', 'S', 'D'].map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
            </dt>
            <dd>{t('hud.controls.move')}</dd>
          </div>
          <div>
            <dt>
              <kbd>Space</kbd>
            </dt>
            <dd>{t('hud.controls.jump')}</dd>
          </div>
          <div>
            <dt>{t('hud.controls.clickScreen')}</dt>
            <dd>{t('hud.controls.lockPointer')}</dd>
          </div>
          <div>
            <dt>
              <kbd>Esc</kbd>
            </dt>
            <dd>{t('hud.controls.releaseCursor')}</dd>
          </div>
        </dl>
      </section>
      <section className="controls-help-group">
        <h3>
          <Hammer size={16} aria-hidden="true" />
          {t('hud.controls.buildingGroup')}
        </h3>
        <dl>
          <div>
            <dt>{t('hud.controls.mouseAction')}</dt>
            <dd>{t('hud.controls.breakPlaceAction')}</dd>
          </div>
          <div>
            <dt>{t('hud.controls.switchMaterialKey')}</dt>
            <dd>{t('hud.controls.switchMaterialAction')}</dd>
          </div>
        </dl>
        <p className="controls-help-note">{t('hud.controls.rangeHint')}</p>
      </section>
      <section className="controls-help-group">
        <h3>
          <MessagesSquare size={16} aria-hidden="true" />
          {t('hud.controls.communicationGroup')}
        </h3>
        <dl>
          <div>
            <dt>
              <kbd>Enter</kbd>
            </dt>
            <dd>{t('hud.controls.openChat')}</dd>
          </div>
          <div>
            <dt>
              <kbd>V</kbd>
            </dt>
            <dd>{t('voice.toggleMic')}</dd>
          </div>
          <div>
            <dt>
              <kbd>L</kbd>
            </dt>
            <dd>{t('voice.toggleListen')}</dd>
          </div>
        </dl>
        <div className="controls-help-note">
          <p>{t('voice.spatialHelp')}</p>
          <p>{t('voice.whisperHint')}</p>
        </div>
      </section>
    </section>
  );
}
