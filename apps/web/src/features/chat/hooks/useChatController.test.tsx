// @vitest-environment jsdom
import { act } from 'react';

import { beforeEach, expect, it, vi } from 'vitest';

import type { ChatEntry } from '@voxel/shared';

import { Connection } from '../../../network/connection';

import { useChatController, type ChatController } from './useChatController';

import { installReactMount } from '../../../../test/helpers/react-mount';
const mount = installReactMount();
beforeEach(() => localStorage.clear());

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

it('requires an explicit service for dictation and recorded voice', async () => {
  class TestURL extends URL {
    static createObjectURL() {
      return 'blob:recording';
    }
    static revokeObjectURL() {}
  }
  vi.stubGlobal('URL', TestURL);
  const connection = new Connection();
  connection.status = 'connected';
  let controller!: ChatController;
  function Harness() {
    controller = useChatController(connection);
    return null;
  }
  await mount.render(<Harness />);
  const dictation = vi.spyOn(controller.dictation, 'start');
  const recorder = vi.spyOn(controller.recorder, 'start');
  await act(async () => controller.record('text'));
  expect(controller.error).toContain('请联系管理员');
  expect(dictation).not.toHaveBeenCalled();
  await act(async () => controller.record('audio'));
  expect(controller.error).toContain('请联系管理员');
  expect(recorder).not.toHaveBeenCalled();
  await act(async () => controller.setClip(new Blob(['audio'])));
  await act(async () => controller.send());
  expect(controller.error).toContain('语音消息转文字');
  expect(controller.clip).toBeDefined();
});
