// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SpeachesModel, SpeachesConnectionDraft } from '@voxel/shared';
import { installReactMount } from '../../../test/helpers/react-mount';
import { SpeachesModelSelect } from './SpeachesModelSelect';
const voiceApi = {
  listSpeachesModels:
    vi.fn<
      (
        connection: SpeachesConnectionDraft,
        signal?: AbortSignal,
      ) => Promise<{ models: SpeachesModel[] }>
    >(),
};

const mount = installReactMount();
const models: SpeachesModel[] = [
  {
    id: 'vendor/new-tts',
    languages: ['zh'],
    voices: [{ id: 'speaker:2', name: 'Two', language: 'zh' }],
  },
];
const change = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  change.mockReset();
});
afterEach(() => vi.useRealTimers());
const render = (
  baseUrl = 'http://speech:8000/v1',
  model = '',
  voice = '',
  active = true,
) =>
  mount.render(
    <SpeachesModelSelect
      loadModels={voiceApi.listSpeachesModels}
      baseUrl={baseUrl}
      apiKey="draft-key"
      serviceId="saved-service"
      model={model}
      voice={voice}
      active={active}
      onChange={change}
    />,
  );
const load = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(350);
  });

it('loads the current draft connection, lists arbitrary models and selects the service voice ID', async () => {
  const request = vi
    .spyOn(voiceApi, 'listSpeachesModels')
    .mockResolvedValue({ models });
  await render();
  await load();
  expect(request).toHaveBeenCalledWith(
    {
      baseUrl: 'http://speech:8000/v1',
      apiKey: 'draft-key',
      serviceId: 'saved-service',
    },
    expect.any(AbortSignal),
  );
  const select = mount.host.querySelector('select')!;
  expect(select.textContent).toContain('vendor/new-tts');
  expect(select.textContent).not.toContain('huayan');
  await act(async () => {
    select.value = models[0].id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(change).toHaveBeenCalledWith({
    model: 'vendor/new-tts',
    voice: 'speaker:2',
  });
  await render(undefined, 'vendor/new-tts', 'speaker:2');
  expect(mount.host.querySelectorAll('select')[1].value).toBe('speaker:2');
  expect(mount.host.textContent).toContain('Two');
});

it('clears old options, aborts requests and ignores late responses after the endpoint changes', async () => {
  const pending: ((value: { models: SpeachesModel[] }) => void)[] = [];
  const request = vi
    .spyOn(voiceApi, 'listSpeachesModels')
    .mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  await render('http://old/v1');
  await load();
  const firstSignal = request.mock.calls[0][1]!;
  await render('http://new/v1');
  await load();
  expect(firstSignal.aborted).toBe(true);
  await act(async () => pending[1]({ models }));
  expect(mount.host.textContent).toContain('vendor/new-tts');
  await act(async () =>
    pending[0]({ models: [{ id: 'old/tts', languages: [], voices: [] }] }),
  );
  expect(mount.host.textContent).not.toContain('old/tts');
  await render('http://third/v1');
  expect(mount.host.textContent).not.toContain('vendor/new-tts');
  await mount.unmount();
  await load();
  expect(request).toHaveBeenCalledTimes(2);
});

it('preserves saved selections on failure and missing models, and refreshes without a hardcoded fallback', async () => {
  const request = vi
    .spyOn(voiceApi, 'listSpeachesModels')
    .mockRejectedValueOnce(new Error('Connection failed'))
    .mockResolvedValueOnce({ models: [] })
    .mockResolvedValueOnce({ models });
  await render(undefined, 'saved/tts', 'saved-voice');
  await load();
  expect(mount.host.querySelector('select')!.value).toBe('saved/tts');
  expect(mount.host.textContent).toContain('Connection failed');
  await act(async () => mount.host.querySelector('button')!.click());
  await load();
  expect(mount.host.textContent).toContain('尚未安装');
  expect(mount.host.querySelector('select')!.value).toBe('saved/tts');
  expect(change).not.toHaveBeenCalled();
  await act(async () => mount.host.querySelector('button')!.click());
  await load();
  expect(request).toHaveBeenCalledTimes(3);
  expect(mount.host.textContent).toContain('vendor/new-tts');
  expect(mount.host.textContent).not.toContain('Connection failed');
});

it('does not request models while the panel is inactive', async () => {
  const request = vi.spyOn(voiceApi, 'listSpeachesModels');
  await render(undefined, '', '', false);
  await load();
  expect(request).not.toHaveBeenCalled();
});
