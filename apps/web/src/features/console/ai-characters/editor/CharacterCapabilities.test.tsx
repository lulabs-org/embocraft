// @vitest-environment jsdom
import { act, useState } from 'react';

import { expect, it } from 'vitest';

import type { AICharacterSettings } from '@voxel/shared';

import { initialAICharacter } from '../model';

import { CharacterCapabilities } from './CharacterCapabilities';

import { installReactMount } from '../../../../../test/helpers/react-mount';

const mount = installReactMount();

let draft: AICharacterSettings;

import { AI_CHARACTER_PERMISSIONS } from '@voxel/shared';

function Harness() {
  const [agent, setAgent] = useState<AICharacterSettings>(initialAICharacter);
  draft = agent;
  return <CharacterCapabilities agent={agent} setAgent={setAgent} />;
}

function permission(id: string) {
  const name = AI_CHARACTER_PERMISSIONS.find((p) => p.id === id)!.name;
  return [
    ...mount.host.querySelectorAll<HTMLLabelElement>(
      'label.agents-capability-card',
    ),
  ]
    .find((el) => el.querySelector('strong')?.textContent === name)!
    .querySelector<HTMLInputElement>('input')!;
}

it('keeps edit permissions synchronized with allowEdits', async () => {
  await act(async () => mount.render(<Harness />));
  await act(async () => permission('place').click());
  expect(draft.permissions?.place).toBe(true);
  expect(draft.allowEdits).toBe(false);
  await act(async () => permission('remove').click());
  expect(draft.allowEdits).toBe(true);
  await act(async () => permission('place').click());
  expect(draft.allowEdits).toBe(false);
  expect(draft.permissions?.remove).toBe(true);
});
