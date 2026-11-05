import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { formatClientHost, resolveServerUrls } from './address';

describe('formatClientHost', () => {
  it('maps 0.0.0.0 and :: wildcards to loopback 127.0.0.1', () => {
    expect(formatClientHost('0.0.0.0')).toBe('127.0.0.1');
    expect(formatClientHost('::')).toBe('127.0.0.1');
  });

  it('preserves IPv4 addresses and hostnames', () => {
    expect(formatClientHost('127.0.0.1')).toBe('127.0.0.1');
    expect(formatClientHost('localhost')).toBe('localhost');
    expect(formatClientHost('192.168.1.100')).toBe('192.168.1.100');
  });

  it('wraps IPv6 addresses in brackets for URI conformity', () => {
    expect(formatClientHost('::1')).toBe('[::1]');
    expect(formatClientHost('2001:db8::1')).toBe('[2001:db8::1]');
  });
});

describe('resolveServerUrls', () => {
  it('constructs correct http and ws URLs for IPv4 addresses', () => {
    const address = { port: 8080 } as AddressInfo;
    const urls = resolveServerUrls(address, '0.0.0.0');
    expect(urls).toEqual({
      httpUrl: 'http://127.0.0.1:8080',
      wsUrl: 'ws://127.0.0.1:8080',
    });
  });

  it('constructs correct http and ws URLs for IPv6 addresses', () => {
    const address = { port: 9000 } as AddressInfo;
    const urls = resolveServerUrls(address, '::1');
    expect(urls).toEqual({
      httpUrl: 'http://[::1]:9000',
      wsUrl: 'ws://[::1]:9000',
    });
  });
});
