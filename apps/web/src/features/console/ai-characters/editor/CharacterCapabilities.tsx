import { useI18n } from '../../../../i18n/context';
import type { AICharacterFormProps } from './types';
import {
  AI_CHARACTER_PERMISSIONS,
  AI_CHARACTER_SKILLS,
  aiCharacterPermissions,
} from '@voxel/shared';
import { Sparkles, ShieldCheck, AlertTriangle } from 'lucide-react';
export function CharacterCapabilities({
  agent,
  setAgent,
}: Pick<AICharacterFormProps, 'agent' | 'setAgent'>) {
  const { t } = useI18n();
  const permissions = aiCharacterPermissions(agent);
  return (
    <>
      {' '}
      <div className="agents-form-section">
        <h4>
          <Sparkles size={14} />
          {t('console.characters.skillsSectionTitle')}
        </h4>
        <p className="agent-hint">
          {t('console.characters.skillsSectionHint')}
        </p>
        <div className="agents-capability-grid">
          {AI_CHARACTER_SKILLS.map((skill) => {
            const checked = agent.skills?.includes(skill.id) ?? false;
            const missing = skill.requires.filter((id) => !permissions[id]);

            return (
              <label
                key={skill.id}
                className={`agent-check agents-permission agents-capability-card${checked ? ' is-checked' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) =>
                    setAgent({
                      ...agent,
                      skills: event.target.checked
                        ? [...(agent.skills ?? []), skill.id]
                        : (agent.skills ?? []).filter((id) => id !== skill.id),
                    })
                  }
                />
                <span className="agents-capability-body">
                  <strong className="agents-capability-name">
                    {skill.name}
                  </strong>
                  <small className="agents-capability-desc">
                    {skill.description}
                  </small>
                  <small className="agents-capability-requires">
                    {t('console.characters.requiredPermissions')}
                    {skill.requires
                      .map(
                        (id) =>
                          AI_CHARACTER_PERMISSIONS.find((p) => p.id === id)!
                            .name,
                      )
                      .join(', ')}
                  </small>
                  {checked && missing.length > 0 && (
                    <small className="agents-capability-warning">
                      <AlertTriangle
                        size={12}
                        className="agents-warning-icon"
                      />
                      {t('console.characters.restrictedExecution', {
                        missing: missing
                          .map(
                            (id) =>
                              AI_CHARACTER_PERMISSIONS.find((p) => p.id === id)!
                                .name,
                          )
                          .join(', '),
                      })}
                    </small>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="agents-form-section">
        <h4>
          <ShieldCheck size={14} />
          {t('console.characters.actionsSectionTitle')}
        </h4>
        <p className="agent-hint">
          {t('console.characters.actionsSectionHint')}
        </p>
        <div className="agents-capability-grid">
          {AI_CHARACTER_PERMISSIONS.map((permission) => {
            const isChecked = !!permissions[permission.id];

            return (
              <label
                key={permission.id}
                className={`agent-check agents-permission agents-capability-card${isChecked ? ' is-checked' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={(event) => {
                    const next = {
                      ...permissions,
                      [permission.id]: event.target.checked,
                    };
                    setAgent({
                      ...agent,
                      permissions: next,
                    });
                  }}
                />
                <span className="agents-capability-body">
                  <strong className="agents-capability-name">
                    {permission.name}
                  </strong>
                  <small className="agents-capability-desc">
                    {permission.description}
                  </small>
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </>
  );
}
