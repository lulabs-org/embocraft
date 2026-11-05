import { expect, it, vi } from 'vitest';
import { domainEvents } from '../src/core/events/domain-events';
import { ttsService, type ResolvedSpeech } from '../src/modules/tts';
import { AgentSpeech } from '../src/modules/world/services/agent-speech.service';
import { Avatar } from '../src/modules/world/world.schema';
import { createTestServer } from './helpers/test-server';

it('cancels a pending browser resolution after a saved voice changes', async () => {
  const server = await createTestServer();
  const room = server.world;
  const notify = vi.fn();
  const report = vi.fn();
  let release!: () => void;
  try {
    const saved = await ttsService.save({
      name: 'Browser',
      type: 'browser',
      voice: 'old',
      speed: 1,
    });
    const actor = Object.assign(new Avatar(), {
      id: 'ai',
      kind: 'ai-agent',
      voiceReplies: true,
    });
    const listener = Object.assign(new Avatar(), {
      id: 'listener',
      voiceListening: true,
    });
    room.state.players.set(actor.id, actor);
    room.state.players.set(listener.id, listener);
    room.agentSpeech.close();
    const resolveActorSpeech = (
      room as unknown as {
        resolveActorSpeech(actor: string): Promise<ResolvedSpeech>;
      }
    ).resolveActorSpeech.bind(room);
    room.agentSpeech = new AgentSpeech(
      () => room.state.players.values(),
      notify,
      report,
      resolveActorSpeech,
    );
    domainEvents.emit('agent.voice.bound', {
      sessionId: actor.id,
      serviceId: saved.id,
    });

    const original = ttsService.resolveSpeech.bind(ttsService);
    vi.spyOn(ttsService, 'resolveSpeech').mockImplementationOnce(async (id) => {
      const speech = await original(id);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return speech;
    });
    const message = {
      kind: 'text' as const,
      scope: 'public' as const,
      recipients: [],
      text: 'hello',
      name: 'AI',
    };
    room.agentSpeech.enqueue(actor.id, message);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await ttsService.save({ ...saved, voice: 'new' }, saved.id);
    room.agentSpeech.enqueue(actor.id, message);
    release();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(notify.mock.calls[0][1]).toMatchObject({
      browserVoice: { voice: 'new' },
    });
    expect(report).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await server.close();
  }
});
