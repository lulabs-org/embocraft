// @vitest-environment jsdom
import { act, useState } from 'react';

import { expect, it } from 'vitest';

import type { AICharacterSettings } from '@voxel/shared';

import { initialAICharacter } from '../model';

import { CharacterBudgetSettings } from './CharacterBudgetSettings';

import { installReactMount } from '../../../../../test/helpers/react-mount';

const mount = installReactMount();

let draft: AICharacterSettings;

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [agent, setAgent] = useState<AICharacterSettings>({
    ...initialAICharacter,
    tokenBudget: 123456,
  });
  draft = agent;
  return (
    <fieldset disabled={disabled}>
      <CharacterBudgetSettings agent={agent} setAgent={setAgent} />
    </fieldset>
  );
}

it('retains configured budgets when toggled off and respects the parent disabled fieldset', async () => {
  await act(async () => mount.render(<Harness />));
  const toggle = mount.host.querySelector<HTMLButtonElement>(
    '#task-limits-switch',
  )!;
  await act(async () => toggle.click());
  expect(draft.taskLimitsEnabled).toBe(true);
  expect(mount.host.querySelector('.agents-budget-content')).not.toBeNull();
  await act(async () => toggle.click());
  expect(draft.taskLimitsEnabled).toBe(false);
  expect(draft.tokenBudget).toBe(123456);
  await act(async () => mount.render(<Harness disabled />));
  await act(async () => toggle.click());
  expect(draft.taskLimitsEnabled).toBe(false);
});
