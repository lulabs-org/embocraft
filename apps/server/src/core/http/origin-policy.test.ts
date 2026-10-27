import { describe, expect, it } from 'vitest';
import { originAllowed } from './origin-policy';

describe('local page origins', () => {
  it.each([
    ['http://localhost:5173', 'http://127.0.0.1:5173'],
    ['http://127.0.0.1:5173', 'http://localhost:5173'],
  ])('accepts %s as the loopback alias of %s', (origin, allowed) => {
    expect(originAllowed(origin, allowed)).toBe(true);
  });

  it.each([
    undefined,
    'null',
    'http://localhost:5174',
    'https://localhost:5173',
    'http://localhost:5173/path',
    'http://localhost.evil.example:5173',
    'http://192.168.1.100:5173',
  ])('rejects an unexpected origin: %s', (origin) => {
    expect(originAllowed(origin, 'http://127.0.0.1:5173')).toBe(false);
  });

  it('retains missing-origin and wildcard policies', () => {
    expect(originAllowed(undefined, 'http://127.0.0.1:5173', false)).toBe(true);
    expect(originAllowed('https://example.com', '*')).toBe(true);
    expect(
      originAllowed('http://localhost:5173', 'https://world.example'),
    ).toBe(false);
  });
});
