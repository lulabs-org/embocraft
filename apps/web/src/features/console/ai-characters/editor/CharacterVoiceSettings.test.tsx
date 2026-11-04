// @vitest-environment jsdom
import { act, useState } from 'react';

import { expect, it } from 'vitest';

import type { AICharacterSettings } from '@voxel/shared';

import { initialAICharacter } from '../model';

import { CharacterVoiceSettings } from './CharacterVoiceSettings';

import { installReactMount } from '../../../../../test/helpers/react-mount';

const mount = installReactMount();

let draft: AICharacterSettings;

import {
  aiCharacterPermissions,
  type LiveVoiceView,
  type VoiceServiceView,
} from '@voxel/shared';

let change!: React.Dispatch<React.SetStateAction<AICharacterSettings>>;
function Harness({
  services = [],
  liveServices = [],
}: {
  services?: VoiceServiceView[];
  liveServices?: LiveVoiceView[];
}) {
  const [agent, setAgent] = useState<AICharacterSettings>(initialAICharacter);
  change = setAgent;
  draft = agent;
  return (
    <CharacterVoiceSettings
      agent={agent}
      setAgent={setAgent}
      voiceServices={services}
      liveVoiceServices={liveServices}
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

it('binds a live conversation service independently of TTS voice replies', async () => {
  const liveServices = [
    {
      id: 'live-a',
      name: 'Live',
      model: 'gpt-live-1',
      voice: 'marin',
      provider: 'openai',
      hasApiKey: true,
    },
  ] as LiveVoiceView[];
  await mount.render(<Harness liveServices={liveServices} />);
  const select = mount.host.querySelector('select')!;
  await act(async () => {
    select.value = 'live-a';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(draft.liveVoiceServiceId).toBe('live-a');
  expect(draft.voiceReplies).toBe(false);
});
