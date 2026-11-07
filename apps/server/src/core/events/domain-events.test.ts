import { describe, expect, it, vi } from 'vitest';
import { DomainEventBus } from './domain-events';

describe('DomainEventBus', () => {
  it('deduplicates listeners and lets either subscription unsubscribe', () => {
    const bus = new DomainEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.on('provider.changed', listener);
    bus.on('provider.changed', listener);

    bus.emit('provider.changed', { providerId: 'provider' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ providerId: 'provider' });

    unsubscribe();
    bus.emit('provider.changed', { providerId: 'provider' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispatches a snapshot synchronously and propagates listener errors', () => {
    const bus = new DomainEventBus();
    const listener = vi.fn();
    const error = new Error('blocked');
    let unsubscribe = () => {};
    bus.on('provider.removing', () => unsubscribe());
    unsubscribe = bus.on('provider.removing', listener);
    bus.on('provider.removing', () => {
      throw error;
    });

    expect(() =>
      bus.emit('provider.removing', { providerId: 'provider' }),
    ).toThrow(error);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clears all listeners', () => {
    const bus = new DomainEventBus();
    const listener = vi.fn();
    bus.on('provider.changed', listener);
    bus.clear();
    bus.emit('provider.changed', { providerId: 'provider' });
    expect(listener).not.toHaveBeenCalled();
  });
});

it('delivers settled notifications to all listeners and reports failures without changing guard behavior', () => {
  const bus = new DomainEventBus();
  const later = vi.fn();
  const remove = bus.on('tts.service.changed', () => {
    throw new Error('private');
  });
  bus.on('tts.service.changed', later);
  expect(bus.emitSettled('tts.service.changed', { serviceId: 'voice' })).toBe(
    false,
  );
  expect(later).toHaveBeenCalledExactlyOnceWith({ serviceId: 'voice' });
  remove();
  expect(bus.emitSettled('tts.service.changed', { serviceId: 'voice' })).toBe(
    true,
  );
  expect(later).toHaveBeenCalledTimes(2);
});
