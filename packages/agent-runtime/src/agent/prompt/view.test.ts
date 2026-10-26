import { expect, it } from 'vitest';
import { buildMessages, observation } from '../../../test/prompt-fixture';

it('bounds world context while preserving the latest events and previous task', () => {
  const input = observation();
  const before = structuredClone(input);
  const previous = {
    task: { goal: '继续建造' },
    decisionError: '请修正上一步',
  };
  const messages = buildMessages(input, previous, { allowEdits: false });
  const payload = JSON.parse(messages[1].content);
  expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
  expect(payload.observation.players).toEqual(input.players.slice(0, 16));
  expect(payload.observation.blocks).toEqual(
    input.blocks.slice(0, 500).map((b) => [b.x, b.y, b.z, b.material]),
  );
  expect(payload.observation.events).toEqual(input.events.slice(-12));
  expect(payload.previous).toEqual(previous);
  expect(messages[0].content).toContain('UNIFIED CHARACTER');
  expect(messages[0].content).toContain('"place":false');
  expect(input).toEqual(before);
});
