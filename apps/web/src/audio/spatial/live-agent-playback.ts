import { spatialMix, type Player } from '@voxel/shared';

/** Plays 24 kHz PCM as it arrives while tracking the Agent's location. */
export class LiveAgentPlayback {
  private readonly gain: GainNode;
  private readonly pan: StereoPannerNode;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  private disposed = false;
  constructor(private readonly context: AudioContext) {
    this.gain = context.createGain();
    this.pan = context.createStereoPanner();
    this.gain.gain.value = 0;
    this.gain.connect(this.pan).connect(context.destination);
  }
  update(listener: Player, agent: Player) {
    if (this.disposed) return;
    const mix = spatialMix(listener, agent);
    this.gain.gain.setTargetAtTime(mix.gain, this.context.currentTime, 0.04);
    this.pan.pan.setTargetAtTime(mix.pan, this.context.currentTime, 0.04);
  }
  append(pcm: ArrayBuffer, sampleRate: number) {
    if (this.disposed) return;
    if (
      sampleRate !== 24000 ||
      pcm.byteLength === 0 ||
      pcm.byteLength % 2 ||
      pcm.byteLength > 65536
    )
      throw new Error('实时语音音频格式无效。');
    const start = Math.max(this.context.currentTime, this.nextAt);
    if (start - this.context.currentTime > 5) {
      this.interrupt();
      throw new Error('实时语音播放延迟过高，请重新连接。');
    }
    const view = new DataView(pcm);
    const buffer = this.context.createBuffer(1, pcm.byteLength / 2, sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++)
      samples[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
    source.start(start);
    this.nextAt = start + buffer.duration;
  }
  interrupt() {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* A source may already have stopped. */
      }
      source.disconnect();
    }
    this.sources.clear();
    this.nextAt = this.context.currentTime;
  }
  dispose() {
    if (this.disposed) return;
    this.interrupt();
    this.disposed = true;
    this.gain.disconnect();
    this.pan.disconnect();
  }
}
