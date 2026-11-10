// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  DEFAULT_MIMO_TTS_VOICE,
  DEFAULT_PIPER_MODEL,
  MIMO_TTS_MODEL,
  type VoiceServiceView,
} from '@voxel/shared';
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

// Changing a preset voice marks the form dirty; preview must still work.
it('previews a newly selected MiMo voice without saving it first', async () => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:preview');
      static revokeObjectURL = vi.fn();
    },
  );
  const preview = vi
    .spyOn(voiceApi, 'previewVoice')
    .mockResolvedValue(new Blob(['audio']));
  const mimo: VoiceServiceView = {
    id: 'mimo-voice',
    name: 'Xiaomi MiMo',
    type: 'mimo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: MIMO_TTS_MODEL,
    voice: DEFAULT_MIMO_TTS_VOICE,
    speed: 1,
    capability: 'tts',
    hasApiKey: true,
  };
  await mount.render(
    <VoiceServices services={[mimo]} onChange={vi.fn()} active />,
  );
  const voice = mount.host.querySelectorAll('select')[1];
  await act(async () => {
    voice.value = '冰糖';
    voice.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const button = mount.host.querySelector<HTMLButtonElement>(
    '.tts-preview button',
  )!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(preview).toHaveBeenCalledOnce();
  expect(preview.mock.calls[0][0]).toMatchObject({
    serviceId: mimo.id,
    draft: { type: 'mimo', voice: '冰糖' },
    text: expect.any(String),
  });
});
