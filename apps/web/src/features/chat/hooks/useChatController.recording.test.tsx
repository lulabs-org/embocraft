// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Player } from '@voxel/shared';
import { installReactMount } from '../../../../test/helpers/react-mount';
import { ClipRecorder } from '../../../audio';
import { Connection } from '../../../network/connection';
import { i18n } from '../../../i18n';
import { chooseAsrService } from '../../voice/asr-selection';
import { ChatComposer } from '../components/ChatComposer';
import { chatApi } from '../api';
import { useChatController, type ChatController } from './useChatController';

const mount = installReactMount();
let controller: ChatController;
let connection: Connection;
let done: Parameters<ClipRecorder['start']>[0];
let fail: Parameters<ClipRecorder['start']>[1];
let ready: Parameters<ClipRecorder['start']>[2];
const peer = { id: 'peer', name: 'Peer', connected: true } as Player;
const button = (label: string) => {
  const result = mount.host.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  expect(result).not.toBeNull();
  return result!;
};
function Harness() {
  controller = useChatController(connection);
  return <ChatComposer controller={controller} />;
}
beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('zh');
  chooseAsrService('clip', {
    id: 'clip-asr',
    name: 'Test Whisper',
    provider: 'whisper',
  });
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL() {
        return 'blob:test';
      }
      static revokeObjectURL() {}
    },
  );
  connection = new Connection();
  connection.status = 'connected';
  connection.players = [peer];
});
async function start(scope: 'public' | 'private' = 'public') {
  vi.spyOn(ClipRecorder.prototype, 'start').mockImplementation(
    async (onDone, onError, onReady) => {
      done = onDone;
      fail = onError;
      ready = onReady;
      onReady();
    },
  );
  const finish = vi
    .spyOn(ClipRecorder.prototype, 'finish')
    .mockImplementation(() => {});
  const upload = vi
    .spyOn(chatApi, 'uploadAudio')
    .mockResolvedValue({ transcriptAvailable: true });
  const textSend = vi.spyOn(connection, 'requestAction').mockResolvedValue();
  await mount.render(<Harness />);
  await act(async () => {
    controller.setScope(scope);
    controller.setRecipients([peer]);
    controller.setText('原有文字草稿');
  });
  await act(async () => controller.record('audio'));
  return { finish, upload, textSend };
}
const finishAndSend = async () =>
  act(async () => button('结束录音并发送语音').click());

it.each(['public', 'private'] as const)(
  'waits for the complete audio and uploads exactly once with %s recipients',
  async (scope) => {
    const { finish, upload, textSend } = await start(scope);
    const blob = new Blob(['first', 'last'], { type: 'audio/webm' });
    expect(button('结束录音并发送语音').disabled).toBe(false);
    await finishAndSend();
    expect(controller.mode).toBe('finalizing');
    expect(button('发送语音').disabled).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    await act(async () => {
      controller.finishRecording(true);
      controller.finishRecording(true);
      ready();
    });
    expect(finish).toHaveBeenCalledOnce();
    expect(controller.mode).toBe('finalizing');
    await act(async () => {
      done(blob, 6000);
      done(blob, 6000);
    });
    expect(upload).toHaveBeenCalledExactlyOnceWith(
      blob,
      scope,
      ['peer'],
      connection.chatToken,
      expect.any(AbortSignal),
      'clip-asr',
    );
    expect(textSend).not.toHaveBeenCalled();
    expect(controller.clip).toBeUndefined();
    expect(controller.recipients).toEqual(scope === 'private' ? [peer] : []);
  },
);

it.each([true, false])(
  'clears status after successful upload regardless of transcript availability (%s)',
  async (transcriptAvailable) => {
    const { upload } = await start();
    upload.mockResolvedValueOnce({ transcriptAvailable });
    await finishAndSend();
    await act(async () => done(new Blob(['audio']), 1000));
    expect(controller.mode).toBe('idle');
    expect(controller.clip).toBeUndefined();
    expect(controller.text).toBe('');
    expect(controller.error).toBe('');
    expect(controller.status).toBe('');
    expect(mount.host.querySelector('.chat-help')).toBeNull();
  },
);

it.each(['stop', 'automatic'] as const)(
  'keeps %s completion as a local preview until explicitly sent',
  async (kind) => {
    const { finish, upload } = await start();
    const blob = new Blob(['audio']);
    if (kind === 'stop') await act(async () => button('结束录音').click());
    await act(async () => done(blob, 20000));
    expect(finish).toHaveBeenCalledTimes(kind === 'stop' ? 1 : 0);
    expect(upload).not.toHaveBeenCalled();
    expect(controller.clip).toBe(blob);
    expect(controller.status).toBe('');
    expect(button('试听录音').disabled).toBe(false);
    await act(async () => button('发送语音').click());
    expect(upload).toHaveBeenCalledOnce();
  },
);

it.each(['cancel', 'failure', 'disconnect', 'unmount'] as const)(
  'revokes sending on %s even if old callbacks arrive',
  async (kind) => {
    const { upload } = await start();
    await finishAndSend();
    if (kind === 'cancel') await act(async () => controller.cancel());
    else if (kind === 'failure') await act(async () => fail('录音中断'));
    else if (kind === 'disconnect') {
      connection.status = 'disconnected';
      await mount.render(<Harness />);
    } else await mount.unmount();
    await act(async () => {
      ready();
      done(new Blob(['late']), 1000);
    });
    expect(upload).not.toHaveBeenCalled();
    expect(controller.clip).toBeUndefined();
    if (kind !== 'unmount') expect(controller.mode).toBe('idle');
    if (kind === 'failure') expect(controller.error).toContain('语音未发送');
  },
);

it('does not carry a canceled send intent or a stale failure into a new recording', async () => {
  const { upload } = await start();
  await finishAndSend();
  const oldDone = done,
    oldFail = fail;
  await act(async () => controller.cancel());
  await act(async () => controller.record('audio'));
  const blob = new Blob(['new']);
  await act(async () => {
    oldDone(new Blob(['old']), 2000);
    oldFail('旧错误');
    done(blob, 1000);
  });
  expect(upload).not.toHaveBeenCalled();
  expect(controller.clip).toBe(blob);
  expect(controller.error).toBe('');
});

it('retains the complete audio on upload failure and retries the same clip', async () => {
  const { upload } = await start();
  upload.mockRejectedValueOnce(new Error('上传失败'));
  const blob = new Blob(['complete audio']);
  await finishAndSend();
  await act(async () => done(blob, 3000));
  expect(controller.clip).toBe(blob);
  expect(controller.clipDuration).toBe(3000);
  expect(controller.error).toContain('录音已保留');
  expect(controller.status).toBe('');
  expect(button('试听录音').disabled).toBe(false);
  await act(async () => button('发送语音').click());
  expect(upload).toHaveBeenCalledTimes(2);
  expect(upload.mock.calls[1][0]).toBe(blob);
  expect(controller.clip).toBeUndefined();
});

it('keeps the draft when upload cancellation races a successful response', async () => {
  const { upload } = await start();
  let resolve!: (value: { transcriptAvailable: boolean }) => void;
  upload.mockImplementationOnce(
    () =>
      new Promise((accept) => {
        resolve = accept;
      }),
  );
  const blob = new Blob(['audio']);
  await finishAndSend();
  await act(async () => done(blob, 1000));
  expect(controller.mode).toBe('sending');
  expect(mount.host.querySelector('form [role="status"]')?.textContent).toBe(
    '正在发送语音…',
  );
  expect(mount.host.querySelector('.chat-help')).toBeNull();
  await act(async () => button('取消发送').click());
  expect(upload.mock.calls[0][4].aborted).toBe(true);
  await act(async () => resolve({ transcriptAvailable: true }));
  expect(controller.clip).toBe(blob);
  expect(controller.error).toContain('取消');
  expect(controller.mode).toBe('idle');
});

it('does not upload an empty recording or a failed finish', async () => {
  const { finish, upload } = await start();
  await finishAndSend();
  await act(async () => done(new Blob(), 1000));
  expect(controller.error).toContain('录音为空');
  expect(upload).not.toHaveBeenCalled();
  await act(async () => controller.record('audio'));
  finish.mockImplementationOnce(() => {
    throw new Error('stop failed');
  });
  await finishAndSend();
  await act(async () => done(new Blob(['late']), 1000));
  expect(upload).not.toHaveBeenCalled();
  expect(controller.error).toContain('无法结束录音');
});

it('checks recipient availability again while retaining a completed recording', async () => {
  const { upload } = await start('private');
  await finishAndSend();
  connection.players = [];
  const blob = new Blob(['private']);
  await act(async () => done(blob, 1000));
  expect(upload).not.toHaveBeenCalled();
  expect(controller.clip).toBe(blob);
  expect(controller.error).toContain('已离线');
});

it('rejects completed audio from a replaced world session', async () => {
  const { upload } = await start();
  await finishAndSend();
  connection.room = { sessionId: 'replacement' } as Connection['room'];
  await act(async () => done(new Blob(['old-world']), 1000));
  expect(upload).not.toHaveBeenCalled();
  expect(controller.clip).toBeUndefined();
  expect(controller.error).toContain('世界连接已变化');
});
