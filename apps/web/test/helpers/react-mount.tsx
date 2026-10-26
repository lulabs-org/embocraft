import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, vi } from 'vitest';

export function installReactMount() {
  let root: Root;
  let host: HTMLDivElement;
  let mounted = false;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    mounted = true;
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });
  async function render(node: ReactNode) {
    await act(async () => root.render(node));
  }
  async function unmount() {
    await act(async () => root.unmount());
    mounted = false;
  }
  afterEach(async () => {
    if (mounted) await unmount();
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  return {
    get host() {
      return host;
    },
    render,
    unmount,
  };
}
