import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

describe('pcm worklet', () => {
  it.each([44100, 48000])(
    'worklet resamples %iHz across render boundaries to 16kHz PCM',
    (rate) => {
      const chunks: ArrayBuffer[] = [];
      type Processor = new () => { process(inputs: Float32Array[][]): boolean };
      let Constructor!: Processor;
      runInNewContext(
        readFileSync(new URL('./pcm-worklet.js', import.meta.url), 'utf8'),
        {
          sampleRate: rate,
          AudioWorkletProcessor: class {
            port = { postMessage: (chunk: ArrayBuffer) => chunks.push(chunk) };
          },
          registerProcessor: (_: string, c: Processor) => (Constructor = c),
        },
      );
      const processor = new Constructor();
      for (let offset = 0; offset < rate; offset += 128)
        processor.process([
          [new Float32Array(Math.min(128, rate - offset)).fill(0.5)],
        ]);
      expect(chunks).toHaveLength(10);
      expect(
        chunks.every(
          (c) =>
            c.byteLength === 3200 &&
            new DataView(c).getInt16(0, true) === 16384,
        ),
      ).toBe(true);
    },
  );
});
