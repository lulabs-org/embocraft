import { expect, it, vi } from 'vitest';
import { Session } from '@voxel/agent-runtime';
import { MockVoiceProvider } from '../src/modules/audio/services/sessions/mock';
import { createTestServer } from './helpers/test-server';

it('preserves voice actions and closes sessions on replacement, leave and server shutdown', async () => {
  const opened: {
    close: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
  }[] = [];
  const create = vi
    .spyOn(MockVoiceProvider.prototype, 'create')
    .mockImplementation((emit) => {
      const voice = {
        close: vi.fn(),
        interrupt: vi.fn(),
        push: vi.fn(() =>
          emit({
            provider: 'mock',
            state: 'listening',
            turn: 1,
            subtitle: 'fixture',
          }),
        ),
      };
      opened.push(voice);
      return voice;
    });
  const server = await createTestServer();
  const clients: Session[] = [];
  try {
    const a = new Session(server.url),
      b = new Session(server.url);
    clients.push(a, b);
    await a.join('Voice A', 'human');
    await b.join('Voice B', 'human');
    const events: unknown[] = [];
    a.room.onMessage('voice', (event) => events.push(event));
    b.room.onMessage('voice', () => {});
    expect((await a.request('voice.start', { text: 'first' })).ok).toBe(true);
    expect((await b.request('voice.start', { text: 'other' })).ok).toBe(true);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      provider: 'mock',
      requestId: expect.any(String),
      state: 'listening',
    });
    expect((await a.request('voice.start', { text: ' ' })).error).toBe(
      'invalid-voice-input',
    );
    expect(opened[0].close).not.toHaveBeenCalled();
    expect((await a.request('voice.interrupt')).ok).toBe(true);
    expect(opened[0].interrupt).toHaveBeenCalledOnce();
    expect(opened[1].interrupt).not.toHaveBeenCalled();
    expect((await a.request('voice.start', { text: 'replacement' })).ok).toBe(
      true,
    );
    expect(opened[0].close).toHaveBeenCalledOnce();
    expect(
      (await a.request('voice.start', { text: 'bad provider', provider: 123 }))
        .error,
    ).toBe('voice-provider-unavailable');
    expect(opened[2].close).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        provider: 123,
        state: 'error',
        subtitle: '无效语音方案。',
      }),
    );
    expect((await a.request('voice.start', { text: 'last' })).ok).toBe(true);
    await a.close();
    await vi.waitFor(() => expect(opened[3].close).toHaveBeenCalledOnce());
    expect(opened[1].close).not.toHaveBeenCalled();
    await Promise.all([server.close(), server.close()]);
    for (const voice of opened) expect(voice.close).toHaveBeenCalledOnce();
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await server.close();
    create.mockRestore();
  }
}, 15000);
