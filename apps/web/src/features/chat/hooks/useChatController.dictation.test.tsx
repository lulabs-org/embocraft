// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Player } from '@voxel/shared';
import { installReactMount } from '../../../../test/helpers/react-mount';
import { BrowserRecognitionSession, LiveRecorder } from '../../../audio';
import type { LiveSpeechEvents } from '../../../audio/services/live-speech';
import { Connection } from '../../../network/connection';
import { i18n } from '../../../i18n';
import { chooseAsrService } from '../../voice/asr-selection';
import { ChatComposer } from '../components/ChatComposer';
import { useChatController, type ChatController } from './useChatController';

const mount = installReactMount();
let controller: ChatController;
let connection: Connection;
let events: LiveSpeechEvents;
const peer = { id: 'peer', name: 'Peer', connected: true } as Player;
function Harness() {
  controller = useChatController(connection);
  return <ChatComposer controller={controller} />;
}
const button = (label: string) => {
  const result = mount.host.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  expect(result).not.toBeNull();
  return result!;
};
beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('zh');
  connection = new Connection();
  connection.status = 'connected';
  connection.players = [peer];
});
async function start(provider: 'browser' | 'whisper' | 'bailian' = 'browser') {
  chooseAsrService('chat', { id: 'test-asr', name: 'Test ASR', provider });
  vi.spyOn(BrowserRecognitionSession.prototype, 'start').mockImplementation(
    (_language, callbacks) => {
      events = callbacks;
    },
  );
  vi.spyOn(LiveRecorder.prototype, 'start').mockImplementation(
    async (_language, callbacks) => {
      events = callbacks;
      callbacks.onState('listening', '');
    },
  );
  const finish =
    provider === 'browser'
      ? vi
          .spyOn(BrowserRecognitionSession.prototype, 'finish')
          .mockImplementation(() => {})
      : vi.spyOn(LiveRecorder.prototype, 'finish').mockResolvedValue();
  const send = vi.spyOn(connection, 'requestAction').mockResolvedValue();
  await mount.render(<Harness />);
  await act(async () => controller.record('text'));
  return { finish, send };
}
const sendDictation = async () =>
  act(async () => button('结束听写并发送').click());

it.each(['browser', 'whisper'] as const)(
  'waits for all %s final results and sends exactly once with the original audience',
  async (provider) => {
    const { finish, send } = await start(provider);
    await act(async () => controller.cancel());
    await act(async () => {
      controller.setText('草稿');
      controller.setScope('private');
      controller.setRecipients([peer]);
    });
    await act(async () => controller.record('text'));
    await act(async () => {
      events.onFinal('第一句');
      events.onPartial('未确认的临时字幕');
    });
    expect(controller.status).toBe('');
    await sendDictation();
    expect(finish).toHaveBeenCalledOnce();
    expect(controller.dictationSending).toBe(true);
    expect(mount.host.textContent).toContain('确认后发送');
    expect(button('发送消息').disabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      controller.finishDictation(true);
      controller.finishDictation(true);
      events.onFinal('最后一句');
    });
    expect(finish).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      events.onFinal('还有一句');
      events.onEnd();
      events.onEnd();
    });
    expect(send).toHaveBeenCalledExactlyOnceWith('chat', {
      text: '草稿 第一句 最后一句 还有一句',
      scope: 'private',
      recipients: ['peer'],
    });
    expect(controller.text).toBe('');
    expect(controller.status).toBe('');
    expect(controller.recipients).toEqual([peer]);
    expect(controller.dictationSending).toBe(false);
  },
);

it.each(['browser', 'whisper', 'bailian'] as const)(
  'keeps %s stop as review-only without a completion notice, including synchronous final callbacks',
  async (provider) => {
    const { finish, send } = await start(provider);
    finish.mockImplementation(() => {
      events.onFinal('最终文字');
      events.onEnd();
      return Promise.resolve();
    });
    await act(async () => button('结束录音').click());
    expect(send).not.toHaveBeenCalled();
    expect(controller.text).toBe('最终文字');
    expect(controller.status).toBe('');
    expect(controller.mode).toBe('idle');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('聊天消息');
    await act(async () => button('发送消息').click());
    expect(send).toHaveBeenCalledExactlyOnceWith('chat', {
      text: '最终文字',
      scope: 'public',
      recipients: [],
    });
  },
);

it('can request sending while the last result from a manual stop is still pending', async () => {
  const { finish, send } = await start();
  await act(async () => controller.finishDictation());
  await sendDictation();
  expect(finish).toHaveBeenCalledOnce();
  await act(async () => {
    events.onFinal('最后结果');
    events.onEnd();
  });
  expect(send).toHaveBeenCalledOnce();
});

it.each(['cancel', 'error', 'disconnect', 'unmount'] as const)(
  'revokes automatic sending on %s and ignores late callbacks',
  async (reason) => {
    const { send } = await start();
    await act(async () => events.onFinal('已确认的文字'));
    await sendDictation();
    const old = events;
    if (reason === 'unmount') await mount.unmount();
    else if (reason === 'disconnect') {
      connection.status = 'disconnected';
      await mount.render(<Harness />);
    } else
      await act(async () =>
        reason === 'cancel' ? controller.cancel() : events.onError('确认超时'),
      );
    await act(async () => {
      old.onFinal('迟到的内容');
      old.onStatus('迟到的状态');
      old.onEnd();
    });
    expect(send).not.toHaveBeenCalled();
    expect(controller.text).toBe('已确认的文字');
    if (reason === 'error')
      expect(controller.error).toContain('未发送，已确认文字已保留');
  },
);

it('isolates a new dictation from the canceled run and does not inherit its send intent', async () => {
  const { send } = await start();
  await sendDictation();
  const old = events;
  await act(async () => controller.cancel());
  await act(async () => controller.record('text'));
  await act(async () => {
    old.onFinal('旧结果');
    old.onError('旧错误');
    old.onEnd();
    events.onFinal('新结果');
    events.onEnd();
  });
  expect(send).not.toHaveBeenCalled();
  expect(controller.text).toBe('新结果');
  expect(controller.error).toBe('');
});

it('never sends interim-only or empty recognition results', async () => {
  const { send } = await start();
  await act(async () => events.onPartial('仅临时字幕'));
  await sendDictation();
  await act(async () => events.onEnd());
  expect(send).not.toHaveBeenCalled();
  expect(controller.text).toBe('');
  expect(controller.error).toContain('没有识别到可发送');
});

it('preserves confirmed and overflowing sentences and cancels automatic sending', async () => {
  const { send } = await start();
  const long = '文'.repeat(240);
  await act(async () => events.onFinal(long));
  await sendDictation();
  await act(async () => {
    events.onFinal('超出的最后一句');
    events.onEnd();
  });
  expect(send).not.toHaveBeenCalled();
  expect(controller.text).toBe(long);
  expect(controller.overflow).toBe('超出的最后一句');
  expect(controller.error).toContain('未发送');
});

it('retains the complete final text on send failure and allows one deliberate retry', async () => {
  const { send } = await start();
  send.mockRejectedValueOnce(new Error('发送失败'));
  await sendDictation();
  await act(async () => {
    events.onFinal('完整消息');
    events.onEnd();
  });
  expect(controller.text).toBe('完整消息');
  expect(controller.error).toContain('发送失败');
  expect(controller.mode).toBe('idle');
  await act(async () => button('发送消息').click());
  expect(send).toHaveBeenCalledTimes(2);
  expect(controller.text).toBe('');
});

it('revalidates connection and recipients before automatic sending', async () => {
  const { send } = await start();
  await act(async () => controller.cancel());
  await act(async () => {
    controller.setScope('private');
    controller.setRecipients([peer]);
  });
  await act(async () => controller.record('text'));
  await sendDictation();
  connection.players = [];
  await act(async () => {
    events.onFinal('保留的消息');
    events.onEnd();
  });
  expect(send).not.toHaveBeenCalled();
  expect(controller.error).toContain('已离线');
  expect(controller.text).toBe('保留的消息');
  connection.players = [peer];
  await act(async () => controller.record('text'));
  await sendDictation();
  connection.status = 'disconnected'; // Before React processes the disconnect effect.
  await act(async () => events.onEnd());
  expect(send).not.toHaveBeenCalled();
  expect(controller.text).toBe('保留的消息');
});

it('reports a failed stop and preserves text without allowing a late end to send', async () => {
  const { finish, send } = await start('whisper');
  await act(async () => events.onFinal('保留文本'));
  finish.mockRejectedValueOnce(new Error('capture failed'));
  await sendDictation();
  await act(async () => events.onEnd());
  expect(send).not.toHaveBeenCalled();
  expect(controller.text).toBe('保留文本');
  expect(controller.error).toContain('无法结束听写');
});

it('does not send a prior dictation into a replacement world session', async () => {
  const { send } = await start();
  await act(async () => events.onFinal('旧世界的草稿'));
  await sendDictation();
  connection.room = { sessionId: 'replacement-session' } as Connection['room'];
  await act(async () => {
    events.onFinal('迟到结果');
    events.onEnd();
  });
  expect(send).not.toHaveBeenCalled();
  expect(controller.text).toBe('旧世界的草稿');
  expect(controller.error).toContain('世界连接已变化');
});

it('does not clear a new draft when a send from a disconnected session completes late', async () => {
  const { send } = await start();
  let complete!: () => void;
  send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  await sendDictation();
  await act(async () => {
    events.onFinal('旧消息');
    events.onEnd();
  });
  expect(controller.mode).toBe('sending');
  connection.status = 'disconnected';
  await mount.render(<Harness />);
  connection.status = 'connected';
  await mount.render(<Harness />);
  await act(async () => controller.setText('新的草稿'));
  await act(async () => complete());
  expect(controller.text).toBe('新的草稿');
  expect(controller.mode).toBe('idle');
});
