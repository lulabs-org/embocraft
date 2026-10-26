import { describe, expect, it } from 'vitest';
import { hudShortcut } from './hud-input';
const key = (overrides: Partial<Parameters<typeof hudShortcut>[0]> = {}) => ({
  key: 'Enter',
  code: 'Enter',
  isComposing: false,
  keyCode: 13,
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  defaultPrevented: false,
  ...overrides,
});
describe('game HUD shortcuts', () => {
  it('opens chat and maps the four actual material choices', () => {
    expect(hudShortcut(key(), false, false)).toBe('chat');
    expect(
      ['Digit1', 'Digit2', 'Digit3', 'Digit4'].map((code) =>
        hudShortcut(key({ key: code.slice(-1), code }), false, false),
      ),
    ).toEqual(['grass', 'dirt', 'stone', 'wood']);
    expect(
      hudShortcut(key({ key: '5', code: 'Digit5' }), false, false),
    ).toBeUndefined();
  });
  it('does not take keys from forms, buttons, editable text or dialogs', () => {
    expect(hudShortcut(key(), true, false)).toBeUndefined();
    expect(hudShortcut(key(), false, true)).toBeUndefined();
    expect(
      hudShortcut(key({ key: '1', code: 'Digit1' }), true, false),
    ).toBeUndefined();
  });
  it.each([
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { defaultPrevented: true },
  ])('leaves IME, consumed and modified shortcuts alone: %j', (override) => {
    expect(hudShortcut(key(override), false, false)).toBeUndefined();
  });
});
