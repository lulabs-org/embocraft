// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_WHISPER_ASR, type WhisperAsrDraft } from '@voxel/shared';
import { installReactMount } from '../../../test/helpers/react-mount';
import { SpeachesAsrConfig } from './SpeachesAsrConfig';
import { voiceApi } from './api';

const mount = installReactMount();
afterEach(() => vi.useRealTimers());

it('shows the deployment default and discovers ASR models using the edited connection', async () => {
  vi.useFakeTimers();
  vi.spyOn(voiceApi, 'speachesDefaults').mockResolvedValue({
    baseUrl: 'http://default-speech:8000/v1',
  });
  const discover = vi
    .spyOn(voiceApi, 'listSpeachesModels')
    .mockResolvedValue({
      models: [{ id: 'vendor/recognizer', languages: ['en'], voices: [] }],
    });
  function Form() {
    const [draft, setDraft] = useState<WhisperAsrDraft>({
      ...DEFAULT_WHISPER_ASR,
      baseUrl: '',
      model: '',
    });
    return (
      <SpeachesAsrConfig
        draft={draft}
        active
        onChange={(patch) => setDraft((value) => ({ ...value, ...patch }))}
      />
    );
  }
  await mount.render(<Form />);
  const address =
    mount.host.querySelector<HTMLInputElement>('input[type="url"]')!;
  expect(address.placeholder).toBe('http://default-speech:8000/v1');
  expect(address.value).toBe('');
  await act(async () => vi.advanceTimersByTimeAsync(350));
  expect(discover).toHaveBeenLastCalledWith(
    { baseUrl: '', apiKey: '', serviceId: undefined },
    expect.any(AbortSignal),
  );
  const select = mount.host.querySelector('select')!;
  expect(
    select.querySelector('option[value="vendor/recognizer"]'),
  ).not.toBeNull();
  expect(mount.host.querySelectorAll('select')).toHaveLength(1);
  await act(async () => {
    select.value = 'vendor/recognizer';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(select.value).toBe('vendor/recognizer');
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(address, 'http://other:8000/v1');
    address.dispatchEvent(new Event('input', { bubbles: true }));
    const key = mount.host.querySelector('input[type="password"]')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(key, 'new-key');
    key.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(350));
  expect(discover).toHaveBeenLastCalledWith(
    {
      baseUrl: 'http://other:8000/v1',
      apiKey: 'new-key',
      serviceId: undefined,
    },
    expect.any(AbortSignal),
  );
});
