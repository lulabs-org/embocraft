// @vitest-environment jsdom
import { act } from 'react';

import { expect, it, vi } from 'vitest';

import type { ChatEntry } from '@voxel/shared';

import { Connection } from '../../../network/connection';

import { useChatController, type ChatController } from './useChatController';

import { installReactMount } from '../../../../test/helpers/react-mount';
const mount = installReactMount();

it('keeps chat recording alive across rerenders and cancels on disconnect and unmount', async () => {
  const connection = new Connection();
  connection.status = 'connected';
  let controller!: ChatController;
  function Harness({ expanded }: { expanded: boolean }) {
    controller = useChatController(connection, expanded);
    return null;
  }
  await mount.render(<Harness expanded />);
  const dictation = vi.spyOn(controller.dictation, 'cancel');
  const recorder = vi.spyOn(controller.recorder, 'cancel');
  const abort = new AbortController();
  controller.upload.current = abort;
  connection.chatRecording = true;
  await act(async () => {
    controller.setText('draft');
  });
  connection.chats = [{ seq: 5, actor: 'other' } as ChatEntry];
  await mount.render(<Harness expanded />);
  expect(controller.text).toBe('draft');
  expect(dictation).not.toHaveBeenCalled();
  expect(connection.chatRecording).toBe(true);
  await mount.render(<Harness expanded={false} />);
  expect(controller.unread).toBe(0);
  connection.chats = [
    ...connection.chats,
    { seq: 6, actor: 'other' } as ChatEntry,
  ];
  await mount.render(<Harness expanded={false} />);
  expect(controller.unread).toBe(1);
  connection.status = 'disconnected';
  await mount.render(<Harness expanded={false} />);
  expect(abort.signal.aborted).toBe(true);
  expect(connection.chatRecording).toBe(false);
  expect(dictation).toHaveBeenCalledOnce();
  expect(recorder).toHaveBeenCalledOnce();
  await mount.unmount();
  expect(dictation).toHaveBeenCalledTimes(2);
});
