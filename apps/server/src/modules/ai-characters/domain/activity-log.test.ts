import { expect, it } from 'vitest';
import { appendAICharacterLog, restoreAICharacterLogs } from './activity-log';

it('retains the newest 500 entries with their original timestamps', () => {
  const view = restoreAICharacterLogs([]);
  for (let i = 0; i < 520; i++)
    appendAICharacterLog(view, `entry-${i}`, 1000 + i);
  expect(view.logEntries).toHaveLength(500);
  expect(view.logEntries[0]).toEqual({ time: 1020, text: 'entry-20' });
  expect(view.logEntries.at(-1)).toEqual({ time: 1519, text: 'entry-519' });
  const archived = JSON.parse(JSON.stringify(view));
  expect(restoreAICharacterLogs(archived.logEntries)).toEqual(view);
});

it('keeps entries without timestamps as null, and timestamps only new entries', () => {
  const view = restoreAICharacterLogs([
    { time: null, text: 'old-1' },
    { time: null, text: 'old-2' },
  ]);
  appendAICharacterLog(view, 'new', 1234);
  expect(view.logEntries).toEqual([
    { time: null, text: 'old-1' },
    { time: null, text: 'old-2' },
    { time: 1234, text: 'new' },
  ]);
});

it('discards invalid entries while preserving time and text', () => {
  expect(
    restoreAICharacterLogs([
      { time: 100, text: 'a' },
      { time: 200, text: 42 },
      { text: 'b' },
      { time: NaN, text: 'c' },
      { time: -1, text: 'd' },
      { time: 8.64e15, text: 'e' },
      null,
      { time: 500, text: '' },
    ]),
  ).toEqual({
    logEntries: [
      { time: 100, text: 'a' },
      { time: null, text: 'b' },
      { time: null, text: 'c' },
      { time: null, text: 'd' },
      { time: 8.64e15, text: 'e' },
    ],
  });
});
