// Audio output: Int16 stereo samples from the APU are posted to an
// AudioWorklet that plays them through a ring buffer. The worklet source
// is inlined via a Blob URL so no extra emitted asset is needed.

const WORKLET_SRC = `
class GbaAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000;              // ~0.5s per channel
    this.l = new Float32Array(this.cap);
    this.r = new Float32Array(this.cap);
    this.rp = 0;
    this.wp = 0;
    this.port.onmessage = (e) => {
      const d = e.data;            // Int16Array interleaved
      for (let i = 0; i + 1 < d.length; i += 2) {
        const next = (this.wp + 1) % this.cap;
        if (next === this.rp) { this.rp = (this.rp + 1) % this.cap; } // overrun: drop oldest
        this.l[this.wp] = d[i] / 32768;
        this.r[this.wp] = d[i + 1] / 32768;
        this.wp = next;
      }
    };
  }
  process(_in, out) {
    const ol = out[0][0], or = out[0][1] || out[0][0];
    for (let i = 0; i < ol.length; i++) {
      if (this.rp !== this.wp) {
        ol[i] = this.l[this.rp];
        or[i] = this.r[this.rp];
        this.rp = (this.rp + 1) % this.cap;
      } else {
        ol[i] = 0; or[i] = 0;
      }
    }
    return true;
  }
}
registerProcessor("gba-audio", GbaAudio);
`;

export class AudioOut {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  enabled = false;

  /** Must be called from a user gesture. Toggles output on/off. */
  async toggle(): Promise<boolean> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 48000 });
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.node = new AudioWorkletNode(this.ctx, "gba-audio", {
        outputChannelCount: [2],
      });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.6;
      this.node.connect(this.gain).connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.enabled = !this.enabled;
    if (this.gain) this.gain.gain.value = this.enabled ? 0.6 : 0;
    return this.enabled;
  }

  push(samples: Int16Array): void {
    if (this.enabled && this.node && samples.length > 0) {
      this.node.port.postMessage(samples.slice());
    }
  }
}
