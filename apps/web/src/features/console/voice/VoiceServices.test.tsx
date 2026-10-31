// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_PIPER_MODEL, type VoiceServiceView } from '@voxel/shared';
import { installReactMount } from '../../../../test/helpers/react-mount';
import { VoiceServices } from './VoiceServices';
import { voiceApi } from './api';

const mount = installReactMount();
beforeEach(() => {
  vi.spyOn(voiceApi, 'speachesDefaults').mockResolvedValue({
    baseUrl: 'http://deployment-speech:8000/v1',
  });
  vi.spyOn(voiceApi, 'listSpeachesModels').mockResolvedValue({ models: [] });
});
const service: VoiceServiceView = {
  id: 'speaches-voice',
  name: 'My voice',
  type: 'speaches',
  baseUrl: '',
  model: DEFAULT_PIPER_MODEL,
  voice: 'huayan',
  speed: 1,
  capability: 'tts',
  hasApiKey: false,
};

async function input(selector: string, value: string) {
  const element = mount.host.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('edits and saves the Speaches endpoint and optional key with the selected model', async () => {
  const saved = {
    ...service,
    baseUrl: 'http://speech:8000/v1',
    hasApiKey: true,
  };
  const save = vi.spyOn(voiceApi, 'saveVoiceService').mockResolvedValue(saved);
  const onChange = vi.fn();
  await mount.render(
    <VoiceServices services={[service]} onChange={onChange} active />,
  );
  expect(mount.host.querySelector('select')!.value).toBe('speaches');
  expect(
    mount.host.querySelector('option[value="speaches"]')!.textContent,
  ).toContain('Speaches');
  expect(
    mount.host.querySelector<HTMLInputElement>('input[type="url"]')!.required,
  ).toBe(false);
  const address =
    mount.host.querySelector<HTMLInputElement>('input[type="url"]')!;
  expect(address.placeholder).toBe('http://deployment-speech:8000/v1');
  expect(address.value).toBe('');
  expect(mount.host.textContent).toContain(
    '默认地址：http://deployment-speech:8000/v1',
  );
  await input('input[type="url"]', 'http://speech:8000/v1');
  await input('input[type="password"]', 'test-key');
  await act(async () =>
    mount.host
      .querySelector<HTMLButtonElement>('.voice-service-actions .primary')!
      .click(),
  );
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'speaches',
      baseUrl: 'http://speech:8000/v1',
      apiKey: 'test-key',
      model: DEFAULT_PIPER_MODEL,
    }),
    service.id,
  );
  expect(onChange).toHaveBeenCalledWith([saved]);
});

it('keeps an existing key for the deployment default but requests a new key when the address changes', async () => {
  await mount.render(
    <VoiceServices
      services={[{ ...service, hasApiKey: true }]}
      onChange={vi.fn()}
      active
    />,
  );
  expect(mount.host.querySelector('.voice-key-saved')).not.toBeNull();
  expect(mount.host.querySelector('input[type="password"]')).toBeNull();
  await input('input[type="url"]', 'http://another-speech:8000/v1');
  expect(mount.host.querySelector('.voice-key-saved')).toBeNull();
  expect(
    mount.host.querySelector<HTMLInputElement>('input[type="password"]')!.value,
  ).toBe('');
  await input('input[type="url"]', '');
  expect(
    mount.host.querySelector<HTMLInputElement>('input[type="url"]')!
      .placeholder,
  ).toBe('http://deployment-speech:8000/v1');
  expect(mount.host.querySelector('.voice-key-saved')).not.toBeNull();
});
