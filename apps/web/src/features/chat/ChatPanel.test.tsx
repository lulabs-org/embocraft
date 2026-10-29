// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { installReactMount } from '../../../test/helpers/react-mount';
import { Connection } from '../../network/connection';
import { i18n } from '../../i18n';
import { ChatPanel } from './ChatPanel';

const mount = installReactMount();
it('switches to private without opening a picker or losing text, and never sends without recipients', async () => {
  await i18n.changeLanguage('zh');
  const connection = new Connection();
  connection.status = 'connected';
  const send = vi.spyOn(connection, 'requestAction').mockResolvedValue();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    value: vi.fn(),
    configurable: true,
  });
  await mount.render(
    <ChatPanel
      connection={connection}
      expanded
      onExpandedChange={vi.fn()}
      onBusyChange={vi.fn()}
    />,
  );
  const input = mount.host.querySelector<HTMLInputElement>(
    '.chat-composer-input',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, '保留这条草稿');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () =>
    mount.host
      .querySelector<HTMLButtonElement>('[aria-label="私聊 · 仅 @ 对象"]')!
      .click(),
  );
  expect(document.querySelector('.mention-picker')).toBeNull();
  expect(input.value).toBe('保留这条草稿');
  expect(
    mount.host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!
      .disabled,
  ).toBe(true);
  await act(async () =>
    mount.host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(send).not.toHaveBeenCalled();
  expect(mount.host.querySelector('[role="alert"]')?.textContent).toContain(
    '选择私聊对象',
  );
  expect(input.value).toBe('保留这条草稿');
});
