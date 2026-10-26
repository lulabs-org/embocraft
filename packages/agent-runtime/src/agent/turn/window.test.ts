import { expect, it } from 'vitest';
import { decisionWindow, recentInteractions } from './window';

type Message = Parameters<typeof recentInteractions>[0][number];

it('keeps eight human interactions with all completed tool rounds and no orphan results', () => {
  const messages: Parameters<typeof recentInteractions>[0] = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'user', content: `question-${i}`, timestamp: i });
    for (let j = 0; j < 2; j++) {
      const id = `${i}-${j}`;
      messages.push({
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id, name: 'observe', arguments: {} }],
      } as Parameters<typeof recentInteractions>[0][number]);
      messages.push({
        role: 'toolResult',
        toolCallId: id,
        toolName: 'observe',
        content: [{ type: 'text', text: id }],
        isError: false,
        timestamp: i,
      } as Parameters<typeof recentInteractions>[0][number]);
    }
  }
  messages.push({
    role: 'assistant',
    stopReason: 'toolUse',
    content: [
      { type: 'toolCall', id: 'unfinished', name: 'edit', arguments: {} },
    ],
  } as Parameters<typeof recentInteractions>[0][number]);
  const kept = recentInteractions(messages);
  expect(kept.filter((m) => m.role === 'user')).toHaveLength(8);
  expect(kept.filter((m) => m.role === 'assistant')).toHaveLength(16);
  expect(kept.filter((m) => m.role === 'toolResult')).toHaveLength(16);
  expect(JSON.stringify(kept)).not.toContain('question-1');
  expect(JSON.stringify(kept)).not.toContain('unfinished');
});

it('builds the provider transcript from retained turns, system messages and the current input', () => {
  const messages: Message[] = [
    { role: 'system', content: 'system-prompt', timestamp: 0 },
  ];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'user', content: `q${i}`, timestamp: i });
    messages.push({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: `a${i}` }],
      timestamp: i,
    } as Message);
  }
  messages.push({ role: 'user', content: 'current-input', timestamp: 99 });
  messages.push({
    role: 'assistant',
    stopReason: 'toolUse',
    content: [
      { type: 'toolCall', id: 'pending', name: 'observe', arguments: {} },
    ],
  } as Message);

  const kept = decisionWindow(messages, false);
  expect(kept[0]).toBe(messages[0]);
  expect(kept.at(-1)).toBe(messages.at(-2));
  const serialized = JSON.stringify(kept);
  expect(serialized).not.toContain('q0');
  expect(serialized).not.toContain('q1');
  expect(serialized).toContain('q2');
  expect(serialized).not.toContain('pending');
});

it('keeps complete interactions and the current input when history is per audience', () => {
  const messages: Message[] = [
    { role: 'system', content: 'system-prompt', timestamp: 0 },
  ];
  for (let i = 0; i < 10; i++) {
    const id = `call-${i}`;
    messages.push({ role: 'user', content: `question-${i}`, timestamp: i });
    messages.push({
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id, name: 'observe', arguments: {} }],
    } as Message);
    messages.push({
      role: 'toolResult',
      toolCallId: id,
      toolName: 'observe',
      content: [{ type: 'text', text: `result-${i}` }],
      isError: false,
      timestamp: i,
    } as Message);
  }
  messages.push({ role: 'user', content: 'current-input', timestamp: 99 });

  const kept = decisionWindow(messages, true);
  expect(kept[0]).toBe(messages[0]);
  expect(kept.at(-1)).toBe(messages.at(-1));
  expect(JSON.stringify(kept)).not.toContain('question-2');
  expect(JSON.stringify(kept)).toContain('question-3');
});
