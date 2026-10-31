import { expect, it } from 'vitest';
import { readWhisperTranscript } from './transcript';

it('drops uncertain silence and repetition while preserving recognized speech', () => {
  expect(
    readWhisperTranscript({
      text: '语音转写。 Tell me a story. story story story',
      segments: [
        { text: '语音转写。', no_speech_prob: 0.95, avg_logprob: -1.8 },
        { text: ' Tell me a story.', no_speech_prob: 0.01, avg_logprob: -0.2 },
        { text: ' story story story', compression_ratio: 3, avg_logprob: -1.4 },
      ],
    }),
  ).toBe('Tell me a story.');
});

it.each([
  { text: '语音转写。', segments: [] },
  {
    text: '语音转写。',
    segments: [{ text: '语音转写。', no_speech_prob: 0.9, avg_logprob: -2 }],
  },
  {
    text: 'repeat',
    segments: [{ text: 'repeat', compression_ratio: 3, avg_logprob: -2 }],
  },
  { text: '[BLANK_AUDIO]' },
])(
  'treats rejected segments as no speech rather than using aggregate text: %j',
  (value) => {
    expect(() => readWhisperTranscript(value)).toThrow(
      expect.objectContaining({ code: 'no-speech', status: 400 }),
    );
  },
);

it.each([
  { text: '语音转写。', no_speech_prob: 0.9, avg_logprob: -0.1 },
  { text: '很小声', no_speech_prob: 0.1, avg_logprob: -1.1 },
  { text: 'very very very', compression_ratio: 3, avg_logprob: -0.1 },
])(
  'does not blacklist words or reject a segment on one score alone: %j',
  (segment) => {
    expect(
      readWhisperTranscript({ text: segment.text, segments: [segment] }),
    ).toBe(segment.text);
  },
);

it('accepts compatible text-only responses and normalizes whitespace', () => {
  expect(readWhisperTranscript({ text: '  hello\nworld  ' })).toBe(
    'hello world',
  );
});

it.each([
  null,
  {},
  { text: 42 },
  { text: 'x', segments: null },
  { text: 'x', segments: [{}] },
  { text: 'x', segments: [{ text: 'x', avg_logprob: 'bad' }] },
])('rejects malformed results: %j', (value) => {
  expect(() => readWhisperTranscript(value)).toThrow(
    expect.objectContaining({ status: 502 }),
  );
});
