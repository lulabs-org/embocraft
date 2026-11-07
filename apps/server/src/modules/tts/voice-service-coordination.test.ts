import { expect, it } from 'vitest';
import { VoiceServiceReferenceCoordinator } from './voice-service-coordination';

function gate() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}

it('blocks deletion until every in-flight reference is established', async () => {
  const coordinator = new VoiceServiceReferenceCoordinator();
  const firstGate = gate(),
    secondGate = gate();
  const first = coordinator.withReference('voice', () => firstGate.waiting);
  const second = coordinator.withReference('voice', () => secondGate.waiting);
  await expect(
    coordinator.withRemoval('voice', async () => {}),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    coordinator.withRemoval('other', async () => 'ok'),
  ).resolves.toBe('ok');
  firstGate.release();
  await first;
  await expect(
    coordinator.withRemoval('voice', async () => {}),
  ).rejects.toMatchObject({ status: 409 });
  secondGate.release();
  await second;
  await expect(
    coordinator.withRemoval('voice', async () => 'ok'),
  ).resolves.toBe('ok');
});

it('blocks new references and concurrent deletions while removal is in progress', async () => {
  const coordinator = new VoiceServiceReferenceCoordinator();
  const barrier = gate();
  const removal = coordinator.withRemoval('voice', () => barrier.waiting);
  await expect(
    coordinator.withReference('voice', async () => {}),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    coordinator.withRemoval('voice', async () => {}),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    coordinator.withReference('other', async () => 'ok'),
  ).resolves.toBe('ok');
  barrier.release();
  await removal;
  await expect(
    coordinator.withReference('voice', async () => 'ok'),
  ).resolves.toBe('ok');
});

it('releases reservations after failed reference creation or deletion', async () => {
  const coordinator = new VoiceServiceReferenceCoordinator();
  const failure = new Error('failed');
  await expect(
    coordinator.withReference('voice', async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  await expect(
    coordinator.withRemoval('voice', async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  await expect(
    coordinator.withReference('voice', async () => 'ok'),
  ).resolves.toBe('ok');
  await expect(
    coordinator.withRemoval('voice', async () => 'ok'),
  ).resolves.toBe('ok');
});
