// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installReactMount } from '../test/helpers/react-mount';
import { App } from './App';
import { i18n } from './i18n';
import type { Connection } from './network/connection';

const state = vi.hoisted(() => ({
  joined: false,
  preload: vi.fn(),
  resolveConsole: (() => {}) as () => void,
}));
vi.mock('./load-console', () => ({
  preloadConsole: state.preload,
  loadControlConsole: () =>
    new Promise((resolve) => {
      state.resolveConsole = () =>
        resolve({
          default: ({ open }: { open: boolean }) =>
            open ? <div data-testid="loaded-console" /> : null,
        });
    }),
}));
vi.mock('./features/chat', () => ({ ChatPanel: () => null }));
vi.mock('./features/voice', () => ({
  SpatialVoicePanel: () => null,
  useAsrSelectionSync: () => {},
}));
vi.mock('./features/world', async () => ({
  LobbyCard: (await import('./features/world/LobbyCard')).LobbyCard,
  WorldPanel: () => null,
  useWorldScene: () => ({}),
  useWorldSession: () => ({ joined: state.joined, name: '' }),
}));
vi.mock('./features/hud', async () => ({
  GameHeader: (await import('./features/hud/GameHeader')).GameHeader,
  GameFooter: () => null,
  GameMenu: () => null,
  MATERIAL_LABELS: {},
  useGameShortcuts: () => {},
  useHudController: () => ({ setActivePanel: () => {} }),
}));
vi.mock('./hooks/useViewportAdjust', () => ({
  useViewportAdjust: () => ({}),
}));

const mount = installReactMount();
const connection = { status: 'connected' } as Connection;
beforeEach(async () => {
  state.joined = false;
  state.preload.mockClear();
  await i18n.changeLanguage('en');
});
afterEach(() => vi.useRealTimers());

it('preloads on pointer and keyboard intent at every console entry without opening it', async () => {
  await mount.render(<App connection={connection} />);
  const entries = mount.host.querySelectorAll<HTMLButtonElement>(
    '[aria-controls="control-console"], .join-agents',
  );
  expect(entries).toHaveLength(2);
  for (const entry of entries) {
    await act(async () => {
      entry.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      entry.focus();
    });
  }
  expect(state.preload).toHaveBeenCalledTimes(4);
  state.joined = true;
  await mount.render(<App connection={connection} />);
  const entry = mount.host.querySelector<HTMLButtonElement>(
    '[aria-controls="control-console"]',
  )!;
  await act(async () => {
    entry.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    entry.focus();
  });
  expect(state.preload).toHaveBeenCalledTimes(6);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('warms the chunk after joining and cancels scheduled work when leaving or unmounting', async () => {
  vi.useFakeTimers();
  await mount.render(<App connection={connection} />);
  await act(async () => vi.advanceTimersByTime(3000));
  expect(state.preload).not.toHaveBeenCalled();
  state.joined = true;
  await mount.render(<App connection={connection} />);
  await act(async () => vi.advanceTimersByTime(2499));
  expect(state.preload).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(1));
  expect(state.preload).toHaveBeenCalledTimes(1);
  state.preload.mockClear();
  state.joined = false;
  await mount.render(<App connection={connection} />);
  state.joined = true;
  await mount.render(<App connection={connection} />);
  state.joined = false;
  await mount.render(<App connection={connection} />);
  await act(async () => vi.advanceTimersByTime(3000));
  expect(state.preload).not.toHaveBeenCalled();
  state.joined = true;
  await mount.render(<App connection={connection} />);
  await mount.unmount();
  await act(async () => vi.advanceTimersByTime(3000));
  expect(state.preload).not.toHaveBeenCalled();
});

it('allows dismissal during download and stays closed when the chunk finishes', async () => {
  await mount.render(<App connection={connection} />);
  const entry = mount.host.querySelector<HTMLButtonElement>(
    '[aria-controls="control-console"]',
  )!;
  await act(async () => entry.click());
  expect(
    document.querySelector('.console-loading [role="status"]')?.textContent,
  ).toBe(i18n.t('common.loading'));
  const close = document.querySelector<HTMLButtonElement>(
    '.console-loading-close',
  )!;
  expect(document.activeElement).toBe(close);
  await act(async () => close.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => entry.click());
  expect(document.querySelector('.console-loading')).not.toBeNull();
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => state.resolveConsole());
  expect(document.querySelector('[data-testid="loaded-console"]')).toBeNull();
  await act(async () => entry.click());
  expect(
    document.querySelector('[data-testid="loaded-console"]'),
  ).not.toBeNull();
  expect(document.querySelector('.console-loading')).toBeNull();
});
