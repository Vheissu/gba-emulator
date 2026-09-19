// Audio output: Int16 stereo samples from the APU are posted to an
// AudioWorklet that plays them through a ring buffer. The worklet source
// is inlined via a Blob URL so no extra emitted asset is needed.
//
// The emulator is paced by requestAnimationFrame, not by the sound card,
// so the two clocks drift. The worklet reports how full its buffer is and
// the APU's output rate is nudged to hold that level steady.

const SAMPLE_RATE = 48000;
/** Buffered audio to aim for: enough to ride out a late frame. */
const TARGET_FILL = SAMPLE_RATE * 0.06;
const MAX_RATE_ADJUST = 0.005;

const WORKLET_SRC = `
class GbaAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = ${SAMPLE_RATE / 4};
    this.l = new Float32Array(this.cap);
    this.r = new Float32Array(this.cap);
    this.rp = 0;
    this.wp = 0;
    this.blocks = 0;
    this.port.onmessage = (e) => {
      const d = e.data;            // Int16Array interleaved
      for (let i = 0; i + 1 < d.length; i += 2) {
        const next = (this.wp + 1) % this.cap;
        if (next === this.rp) break; // full: drop the rest
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
    if (++this.blocks % 16 === 0) this.port.postMessage((this.wp - this.rp + this.cap) % this.cap);
    return true;
  }
}
registerProcessor("gba-audio", GbaAudio);
`;

export class AudioOut {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private volume = 0.7;
  enabled = false;

  /** Called with the sample rate the APU should produce to keep the
   *  playback buffer level. */
  onRate: (hz: number) => void = () => {};

  /** Must be called from a user gesture. */
  async setEnabled(on: boolean): Promise<void> {
    if (on && !this.ctx) {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.node = new AudioWorkletNode(this.ctx, "gba-audio", { outputChannelCount: [2] });
      this.node.port.onmessage = (e) => this.trackFill(e.data as number);
      this.gain = this.ctx.createGain();
      this.node.connect(this.gain).connect(this.ctx.destination);
    }
    if (on && this.ctx?.state === "suspended") await this.ctx.resume();
    this.enabled = on;
    this.applyGain();
  }

  setVolume(v: number): void {
    this.volume = v;
    this.applyGain();
  }

  private applyGain(): void {
    // Perceived loudness is closer to the square of the slider position.
    if (this.gain) this.gain.gain.value = this.enabled ? this.volume * this.volume : 0;
  }

  private trackFill(fill: number): void {
    const error = (TARGET_FILL - fill) / TARGET_FILL;
    const adjust = Math.max(-MAX_RATE_ADJUST, Math.min(MAX_RATE_ADJUST, error * MAX_RATE_ADJUST));
    this.onRate(SAMPLE_RATE * (1 + adjust));
  }

  /** Takes ownership of `samples`. */
  push(samples: Int16Array): void {
    if (this.enabled && this.node && samples.length > 0) {
      this.node.port.postMessage(samples, [samples.buffer]);
    }
  }
}
