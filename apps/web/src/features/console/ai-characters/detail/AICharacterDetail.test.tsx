// @vitest-environment jsdom
import { StrictMode, type ComponentProps } from 'react';

import { expect, it, vi } from 'vitest';

import type { PublicAICharacterView } from '@voxel/shared/management';

import { AICharacterDetail } from './AICharacterDetail';

import { initialAICharacter } from '../model';

import { installReactMount } from '../../../../../test/helpers/react-mount';
const mount = installReactMount();

vi.mock('../editor/AICharacterForm', () => ({
  AICharacterForm: () => <input aria-label="draft" defaultValue="unsaved" />,
}));

vi.mock('../activity/AICharacterLogViewer', () => ({
  AICharacterLogViewer: () => null,
}));

it('does not reinitialize the role editor when polling updates the same role', async () => {
  const job: PublicAICharacterView = {
    ...initialAICharacter,
    id: 'a',
    name: 'A',
    providerName: 'fixture',
    status: 'idle',
    createdAt: 0,
    resourceVersion: 0,
    taskIdentity: null,
  };
  const open = vi.fn();
  const props = {
    job,
    openAgentEditor: open,
    showAgentForm: true,
    editingAgent: 'a',
    setShowAgentForm: vi.fn(),
    setError: vi.fn(),
    setNotice: vi.fn(),
  } as unknown as ComponentProps<typeof AICharacterDetail>;
  await mount.render(
    <StrictMode>
      <AICharacterDetail {...props} />
    </StrictMode>,
  );
  expect(open).toHaveBeenCalledOnce();
  const draft = mount.host.querySelector('input')!;
  draft.value = 'my unfinished edit';
  const newerOpen = vi.fn();
  await mount.render(
    <StrictMode>
      <AICharacterDetail
        {...props}
        job={{ ...job, status: 'idle' }}
        openAgentEditor={newerOpen}
      />
    </StrictMode>,
  );
  expect(newerOpen).not.toHaveBeenCalled();
  expect(mount.host.querySelector('input')?.value).toBe('my unfinished edit');
  await mount.render(
    <StrictMode>
      <AICharacterDetail
        {...props}
        job={{ ...job, id: 'b' }}
        openAgentEditor={newerOpen}
      />
    </StrictMode>,
  );
  expect(newerOpen).toHaveBeenCalledOnce();
  expect(newerOpen.mock.calls[0][0].id).toBe('b');
});
