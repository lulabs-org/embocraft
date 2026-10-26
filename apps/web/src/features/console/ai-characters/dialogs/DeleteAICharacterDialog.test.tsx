// @vitest-environment jsdom
import { act } from 'react';

import { expect, it, vi } from 'vitest';

import { DeleteAICharacterDialog } from './DeleteAICharacterDialog';

import { installReactMount } from '../../../../../test/helpers/react-mount';
const mount = installReactMount();

it('retains the delete dialog while busy and supports cancelable Escape events', async () => {
  const cancel = vi.fn();
  const props = {
    name: 'A',
    disabled: false,
    error: '',
    onConfirm: vi.fn(),
    onCancel: cancel,
  };
  await mount.render(<DeleteAICharacterDialog {...props} busy />);
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(cancel).not.toHaveBeenCalled();
  await mount.render(<DeleteAICharacterDialog {...props} busy={false} />);
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(cancel).toHaveBeenCalledOnce();
});
