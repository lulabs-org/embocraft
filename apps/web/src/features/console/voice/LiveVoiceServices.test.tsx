// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { installReactMount } from '../../../../test/helpers/react-mount';
import { LiveVoiceServices } from './LiveVoiceServices';
import * as request from '../request';
const mount = installReactMount();
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('creates a Gemini Live service with a server-side key and provider defaults', async () => {
  const save = vi
    .spyOn(request, 'consoleFetch')
    .mockResolvedValue({
      id: 'v1',
      name: 'Agent Voice',
      provider: 'gemini',
      model: 'gemini-3.8-live',
      voice: 'Kore',
      hasApiKey: true,
    });
  const changed = vi.fn();
  await mount.render(<LiveVoiceServices services={[]} onChange={changed} />);
  const select = mount.host.querySelector('select')!;
  await act(async () => {
    select.value = 'gemini';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const inputs = mount.host.querySelectorAll<HTMLInputElement>('input');
  expect(inputs[1].value).toBe('gemini-3.8-live');
  expect(inputs[2].value).toBe('Kore');
  await input(inputs[0], 'Agent Voice');
  await input(inputs[3], 'test-secret');
  await act(async () =>
    mount.host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(save).toHaveBeenCalledWith(
    '/voice/live/services',
    expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        provider: 'gemini',
        apiKey: 'test-secret',
      }),
    }),
  );
  expect(changed).toHaveBeenCalledWith([
    expect.objectContaining({ id: 'v1', hasApiKey: true }),
  ]);
});
