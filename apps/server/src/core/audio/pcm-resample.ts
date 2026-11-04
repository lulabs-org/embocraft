/** Convert 16 kHz PCM16 to 24 kHz while retaining interpolation across frames. */
export class Pcm16Upsampler {
  private previous: number | undefined;
  private index = 0;
  convert(input: Buffer): Buffer {
    const output: number[] = [];
    for (let i = 0; i < input.length; i += 2) {
      const value = input.readInt16LE(i);
      if (this.previous === undefined) output.push(value);
      else if (this.index % 2 === 1) {
        output.push(Math.round((this.previous + 2 * value) / 3));
      } else {
        output.push(Math.round((2 * this.previous + value) / 3), value);
      }
      this.previous = value;
      this.index++;
    }
    const bytes = Buffer.allocUnsafe(output.length * 2);
    output.forEach((sample, i) => bytes.writeInt16LE(sample, i * 2));
    return bytes;
  }
}
