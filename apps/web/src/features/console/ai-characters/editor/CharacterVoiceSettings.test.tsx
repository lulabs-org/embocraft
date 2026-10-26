// @vitest-environment jsdom
import { act, useState } from 'react';

import { expect, it } from 'vitest';

import type { AICharacterSettings } from '@voxel/shared';

import { initialAICharacter } from '../model';

import { CharacterVoiceSettings } from './CharacterVoiceSettings';

import { installReactMount } from '../../../../../test/helpers/react-mount';

const mount = installReactMount();

let draft: AICharacterSettings;

import { aiCharacterPermissions, type VoiceServiceView } from '@voxel/shared';

let change!: React.Dispatch<React.SetStateAction<AICharacterSettings>>;
function Harness({ services = [] }: { services?: VoiceServiceView[] }) {
  const [agent, setAgent] = useState<AICharacterSettings>(initialAICharacter);
  change = setAgent;
  draft = agent;
  return (
    <CharacterVoiceSettings
      agent={agent}
      setAgent={setAgent}
      voiceServices={services}
    />
  );
}

it('requires chat permission and a service for voice, retaining the selected service when switched off', async () => {
  const services = [{ id: 'voice-a', name: 'Voice A' }] as VoiceServiceView[];
  await act(async () => mount.render(<Harness />));
  expect(
    mount.host.querySelector<HTMLButtonElement>('#voice-reply-switch')!
      .disabled,
  ).toBe(true);
  await act(async () => mount.render(<Harness services={services} />));
  const toggle = mount.host.querySelector<HTMLButtonElement>(
    '#voice-reply-switch',
  )!;
  await act(async () => toggle.click());
  expect(draft.voiceReplies).toBe(true);
  expect(draft.voiceServiceId).toBe('voice-a');
  await act(async () => toggle.click());
  expect(draft.voiceReplies).toBe(false);
  expect(draft.voiceServiceId).toBe('voice-a');
  await act(async () =>
    change((agent) => ({
      ...agent,
      permissions: { ...aiCharacterPermissions(agent), chat: false },
    })),
  );
  expect(toggle.disabled).toBe(true);
});
