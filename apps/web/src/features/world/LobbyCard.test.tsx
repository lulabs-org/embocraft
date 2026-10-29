// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { installReactMount } from '../../../test/helpers/react-mount';
import { Connection } from '../../network/connection';
import { i18n } from '../../i18n';
import { LobbyCard } from './LobbyCard';
import { useWorldSession } from './useWorldSession';

const mount = installReactMount();

it('starts empty, rejects blank names, and generates editable names without joining', async () => {
  await i18n.changeLanguage('zh');
  const connection = new Connection();
  const connect = vi.spyOn(connection, 'connect').mockResolvedValue();
  let session!: ReturnType<typeof useWorldSession>;
  const leave = vi.fn();
  function Lobby() {
    session = useWorldSession(connection, leave);
    return (
      <LobbyCard
        name={session.name}
        onNameChange={session.setName}
        onJoin={() => void session.joinWorld()}
        onCreateAgent={vi.fn()}
      />
    );
  }
  await mount.render(<Lobby />);
  const input = mount.host.querySelector<HTMLInputElement>('#name')!;
  expect(input.value).toBe('');
  expect(input.validity.valueMissing).toBe(true);
  await act(async () => session.setName('   '));
  expect(input.validity.patternMismatch).toBe(true);
  await act(async () => {
    expect(await session.joinWorld()).toBe(false);
  });
  expect(connect).not.toHaveBeenCalled();
  const random = mount.host.querySelector<HTMLButtonElement>(
    '.random-player-name',
  )!;
  await act(async () => random.click());
  const firstName = input.value;
  expect(firstName).toMatch(/^[\u4e00-\u9fff]+\d{3}$/);
  expect(input.validity.valid).toBe(true);
  await act(async () => random.click());
  expect(input.value).not.toBe(firstName);
  await act(async () => i18n.changeLanguage('en'));
  await act(async () => random.click());
  expect(input.value).toMatch(/^[A-Za-z]+\d{3}$/);
  expect(input.value.length).toBeLessThanOrEqual(input.maxLength);
  expect(connect).not.toHaveBeenCalled();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, 'Custom Name');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(session.name).toBe('Custom Name');
});
