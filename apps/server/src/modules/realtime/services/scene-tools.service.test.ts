import { afterEach, expect, it, vi } from 'vitest';
import { SceneTools } from './scene-tools.service';

afterEach(() => vi.useRealTimers());
const edit = { x: 2, y: 3, z: 2, material: 'wood' };
function fixture() {
  const observe = vi.fn(() => ({ revision: 3, blocks: [] }));
  const propose = vi.fn();
  const tools = new SceneTools({ observe, revision: () => 3 }, propose);
  const add = () => tools.execute('propose_block_edit', JSON.stringify(edit));
  return { tools, observe, propose, add };
}

it('exposes only consented tools and validates arguments without leaking scene failures', () => {
  const noScene = new SceneTools(undefined, vi.fn());
  expect(noScene.definitions).toEqual([]);
  expect(noScene.execute('observe_scene', '{}')).toEqual({
    error: 'tool-not-allowed',
  });
  const { tools, observe, propose } = fixture();
  expect(tools.execute('observe_scene', '{}')).toEqual({
    revision: 3,
    blocks: [],
  });
  expect(tools.execute('unknown', '{}')).toEqual({ error: 'tool-not-allowed' });
  expect(tools.execute('observe_scene', '{"extra":true}')).toEqual({
    error: 'tool-not-allowed',
  });
  for (const args of [
    null,
    '[]',
    'null',
    '{',
    'x'.repeat(1001),
    JSON.stringify({ ...edit, x: 0.5 }),
    JSON.stringify({ ...edit, material: 'invalid' }),
    JSON.stringify({ ...edit, revision: 9 }),
  ])
    expect(tools.execute('propose_block_edit', args)).toEqual({
      error: 'invalid-tool-arguments',
    });
  expect(propose).not.toHaveBeenCalled();
  observe.mockImplementation(() => {
    throw Error('private scene details');
  });
  expect(tools.execute('observe_scene', '{}')).toEqual({
    error: 'invalid-tool-arguments',
  });
});

it('bounds outstanding proposals and consumes each once with the captured revision', () => {
  const { tools, propose, add } = fixture();
  for (let i = 0; i < 8; i++)
    expect(add()).toMatchObject({ status: 'awaiting-player-approval' });
  expect(add()).toEqual({ error: 'invalid-tool-arguments' });
  const first = propose.mock.calls[0][0];
  expect(() => fixture().tools.takeProposal(first.id)).toThrow(
    'invalid-or-expired-proposal',
  );
  expect(tools.takeProposal(first.id)).toEqual({ ...edit, revision: 3 });
  expect(() => tools.takeProposal(first.id)).toThrow(
    'invalid-or-expired-proposal',
  );
  expect(add()).toMatchObject({ status: 'awaiting-player-approval' });
});

it('preserves the expiration boundary and revokes pending proposals on close', () => {
  vi.useFakeTimers();
  const { tools, propose, add } = fixture();
  add();
  add();
  vi.advanceTimersByTime(30000);
  expect(tools.takeProposal(propose.mock.calls[0][0].id)).toEqual({
    ...edit,
    revision: 3,
  });
  vi.advanceTimersByTime(1);
  expect(() => tools.takeProposal(propose.mock.calls[1][0].id)).toThrow(
    'invalid-or-expired-proposal',
  );
  add();
  tools.close();
  tools.close();
  expect(() => tools.takeProposal(propose.mock.calls[2][0].id)).toThrow(
    'invalid-or-expired-proposal',
  );
  expect(add()).toEqual({ error: 'tool-not-allowed' });
});
