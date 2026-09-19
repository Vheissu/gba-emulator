// GBA APU: 4 PSG channels (2 square, 1 wave, 1 noise) inherited from the
// Game Boy, plus 2 DMA-fed "direct sound" FIFOs. Mixed to stereo int16 at
// the host sample rate.
//
// The PSG register block is byte-oriented, so the bus hands this device
// single bytes. PSG timings are the Game Boy's scaled by 4 (16.78 MHz vs
// 4.19 MHz).

import type { StateReader, StateWriter } from "./state";

const CPU_HZ = 16777216;
const FRAME_SEQ_CYCLES = CPU_HZ / 512;

const DUTY = [0b00000001, 0b10000001, 0b10000111, 0b01111110];
const NOISE_DIVISOR = [8, 16, 32, 48, 64, 80, 96, 112];
const FIFO_SIZE = 32;

// Bits that read back, for 0x60-0x8F. Everything else reads as zero.
const READ_MASK = new Uint8Array(0x30);
READ_MASK.set([0x7f, 0, 0xc0, 0xff, 0, 0x40, 0, 0], 0x00);      // SOUND1
READ_MASK.set([0xc0, 0xff, 0, 0, 0, 0x40, 0, 0], 0x08);         // SOUND2
READ_MASK.set([0xe0, 0, 0, 0xe0, 0, 0x40, 0, 0], 0x10);         // SOUND3
READ_MASK.set([0, 0xff, 0, 0, 0xff, 0x40, 0, 0], 0x18);         // SOUND4
READ_MASK.set([0x77, 0xff, 0x0f, 0x77, 0x80, 0, 0, 0], 0x20);   // SOUNDCNT
READ_MASK.set([0xfe, 0xc3], 0x28);                              // SOUNDBIAS

/** Volume envelope shared by both squares and the noise channel. */
class Envelope {
  volume = 0;
  private initial = 0;
  private up = false;
  private period = 0;
  private timer = 0;

  get dacOn(): boolean { return this.initial !== 0 || this.up; }

  write(v: number): void {
    this.initial = v >> 4;
    this.up = (v & 8) !== 0;
    this.period = v & 7;
  }

  trigger(): void {
    this.volume = this.initial;
    this.timer = this.period;
  }

  clock(): void {
    if (!this.period || --this.timer > 0) return;
    this.timer = this.period;
    if (this.up ? this.volume < 15 : this.volume > 0) this.volume += this.up ? 1 : -1;
  }

  save(w: StateWriter): void {
    w.u8(this.volume); w.u8(this.initial); w.bool(this.up); w.u8(this.period); w.u8(this.timer);
  }
  load(r: StateReader): void {
    this.volume = r.u8(); this.initial = r.u8(); this.up = r.bool(); this.period = r.u8(); this.timer = r.u8();
  }
}

class Fifo {
  private data = new Int8Array(FIFO_SIZE);
  private head = 0;
  length = 0;
  /** Sample currently held on the DAC. */
  sample = 0;

  reset(): void { this.head = this.length = this.sample = 0; }

  push(byte: number): void {
    if (this.length === FIFO_SIZE) return;
    this.data[(this.head + this.length++) % FIFO_SIZE] = byte;
  }

  pop(): void {
    if (this.length === 0) return;
    this.sample = this.data[this.head];
    this.head = (this.head + 1) % FIFO_SIZE;
    this.length--;
  }

  save(w: StateWriter): void { w.array(this.data); w.u8(this.head); w.u8(this.length); w.i32(this.sample); }
  load(r: StateReader): void { r.arrayInto(this.data); this.head = r.u8(); this.length = r.u8(); this.sample = r.i32(); }
}

export class APU {
  /** Requested by a FIFO that has drained to half; 0 = A, 1 = B. */
  onFifoRequest: (fifo: number) => void = () => {};

  private sampleRate = 48000;
  /** Counts up by `sampleRate` per cycle; a sample is due at CPU_HZ. */
  private sampleAcc = 0;
  private seqAcc = 0;
  private seqStep = 0;

  // Output ring buffer (interleaved int16 stereo).
  private ring = new Int16Array(1 << 14);
  private ringR = 0;
  private ringW = 0;
  // DC-blocking high-pass state, per side.
  private hpIn = new Float64Array(2);
  private hpOut = new Float64Array(2);

  private reg = new Uint8Array(0x30); // 0x60-0x8F as written
  private master = false;
  private chOn = [false, false, false, false];
  private length = new Int32Array(4);
  private lengthOn = [false, false, false, false];

  // Squares (index 0/1)
  private sqEnv = [new Envelope(), new Envelope()];
  private sqFreq = new Int32Array(2);
  private sqTimer = new Int32Array(2);
  private sqPhase = new Int32Array(2);
  // Sweep (square 1)
  private sweepShadow = 0;
  private sweepTimer = 0;
  private sweepOn = false;

  // Wave: two 32-sample banks; the one not playing is mapped at 0x90.
  private waveRam = new Uint8Array(32);
  private waveFreq = 0;
  private waveTimer = 0;
  private wavePos = 0;

  // Noise
  private noiseEnv = new Envelope();
  private lfsr = 0x4000;
  private noiseTimer = 0;

  private fifos = [new Fifo(), new Fifo()];

  reset(): void {
    this.reg.fill(0);
    this.reg[0x29] = 0x02; // SOUNDBIAS = 0x200
    this.master = false;
    this.resetPsg();
    this.waveRam.fill(0);
    this.fifos[0].reset(); this.fifos[1].reset();
    this.sampleAcc = this.seqAcc = this.seqStep = 0;
    this.ringR = this.ringW = 0;
    this.hpIn.fill(0); this.hpOut.fill(0);
  }

  private resetPsg(): void {
    this.reg.fill(0, 0, 0x22);
    this.chOn.fill(false);
    this.lengthOn.fill(false);
    this.length.fill(0);
    this.sqEnv.forEach((e) => e.write(0));
    this.noiseEnv.write(0);
    this.sqFreq.fill(0); this.sqPhase.fill(0);
    this.waveFreq = this.wavePos = 0;
    this.sweepOn = false;
  }

  /** Host output rate; nudged slightly by the frontend to track the audio
   *  device's clock. */
  setSampleRate(hz: number): void {
    this.sampleRate = hz;
  }

  // ------------------------------------------------------------------
  // IO (byte registers, 0x060-0x0AF)
  // ------------------------------------------------------------------

  ioRead8(off: number): number {
    if (off >= 0x90 && off < 0xa0) return this.waveRam[this.cpuWaveBank() + off - 0x90];
    if (off >= 0x90) return 0;
    if (off === 0x84) {
      let v = this.master ? 0x80 : 0;
      for (let c = 0; c < 4; c++) if (this.chOn[c]) v |= 1 << c;
      return v;
    }
    return this.reg[off - 0x60] & READ_MASK[off - 0x60];
  }

  ioWrite8(off: number, v: number): void {
    if (off >= 0xa0) {
      if (off < 0xa8) this.fifos[(off - 0xa0) >> 2].push(v);
      return;
    }
    if (off >= 0x90) { this.waveRam[this.cpuWaveBank() + off - 0x90] = v; return; }
    // PSG registers are frozen while the master switch is off.
    if (!this.master && off < 0x82) return;
    this.reg[off - 0x60] = v;

    switch (off) {
      case 0x62: case 0x68: this.length[off === 0x62 ? 0 : 1] = 64 - (v & 0x3f); return;
      case 0x63: case 0x69: {
        const c = off === 0x63 ? 0 : 1;
        this.sqEnv[c].write(v);
        if (!this.sqEnv[c].dacOn) this.chOn[c] = false;
        return;
      }
      case 0x64: case 0x6c: {
        const c = off === 0x64 ? 0 : 1;
        this.sqFreq[c] = (this.sqFreq[c] & 0x700) | v;
        return;
      }
      case 0x65: case 0x6d: {
        const c = off === 0x65 ? 0 : 1;
        this.sqFreq[c] = (this.sqFreq[c] & 0xff) | ((v & 7) << 8);
        this.lengthOn[c] = (v & 0x40) !== 0;
        if (v & 0x80) this.triggerSquare(c);
        return;
      }
      case 0x70: if (!(v & 0x80)) this.chOn[2] = false; return;
      case 0x72: this.length[2] = 256 - v; return;
      case 0x74: this.waveFreq = (this.waveFreq & 0x700) | v; return;
      case 0x75:
        this.waveFreq = (this.waveFreq & 0xff) | ((v & 7) << 8);
        this.lengthOn[2] = (v & 0x40) !== 0;
        if (v & 0x80) this.triggerWave();
        return;
      case 0x78: this.length[3] = 64 - (v & 0x3f); return;
      case 0x79:
        this.noiseEnv.write(v);
        if (!this.noiseEnv.dacOn) this.chOn[3] = false;
        return;
      case 0x7d:
        this.lengthOn[3] = (v & 0x40) !== 0;
        if (v & 0x80) this.triggerNoise();
        return;
      case 0x83:
        if (v & 0x08) this.fifos[0].reset();
        if (v & 0x80) this.fifos[1].reset();
        return;
      case 0x84:
        if (this.master && !(v & 0x80)) this.resetPsg();
        this.master = (v & 0x80) !== 0;
        return;
    }
  }

  /** Offset of the wave bank the CPU sees: the one that is not playing. */
  private cpuWaveBank(): number {
    return this.reg[0x10] & 0x40 ? 0 : 16;
  }

  // ------------------------------------------------------------------
  // Channel triggers
  // ------------------------------------------------------------------

  private triggerSquare(c: number): void {
    this.chOn[c] = this.sqEnv[c].dacOn;
    if (this.length[c] === 0) this.length[c] = 64;
    this.sqTimer[c] = (2048 - this.sqFreq[c]) * 16;
    this.sqEnv[c].trigger();
    if (c !== 0) return;
    const sweep = this.reg[0x00];
    this.sweepShadow = this.sqFreq[0];
    this.sweepTimer = ((sweep >> 4) & 7) || 8;
    this.sweepOn = (sweep & 0x77) !== 0;
    if (sweep & 7 && this.sweepTarget() > 2047) this.chOn[0] = false;
  }

  private triggerWave(): void {
    this.chOn[2] = (this.reg[0x10] & 0x80) !== 0;
    if (this.length[2] === 0) this.length[2] = 256;
    this.waveTimer = (2048 - this.waveFreq) * 8;
    this.wavePos = 0;
  }

  private triggerNoise(): void {
    this.chOn[3] = this.noiseEnv.dacOn;
    if (this.length[3] === 0) this.length[3] = 64;
    this.noiseEnv.trigger();
    this.lfsr = this.reg[0x1c] & 8 ? 0x40 : 0x4000;
    this.noiseTimer = this.noisePeriod();
  }

  private noisePeriod(): number {
    const p = this.reg[0x1c];
    return (NOISE_DIVISOR[p & 7] << (p >> 4)) * 4;
  }

  private sweepTarget(): number {
    const sweep = this.reg[0x00];
    const delta = this.sweepShadow >> (sweep & 7);
    return sweep & 8 ? this.sweepShadow - delta : this.sweepShadow + delta;
  }

  // ------------------------------------------------------------------
  // Timers feeding the FIFOs
  // ------------------------------------------------------------------

  /** Timer 0/1 overflowed: advance whichever FIFOs are clocked by it. */
  timerOverflow(timer: number): void {
    const cntH = this.reg[0x23];
    for (let f = 0; f < 2; f++) {
      if (((cntH >> (f ? 6 : 2)) & 1) !== timer) continue;
      this.fifos[f].pop();
      if (this.fifos[f].length <= FIFO_SIZE / 2) this.onFifoRequest(f);
    }
  }

  // ------------------------------------------------------------------
  // Running
  // ------------------------------------------------------------------

  advance(elapsed: number): void {
    while (elapsed > 0) {
      // Run up to the next output sample or frame-sequencer tick.
      const toSample = Math.ceil((CPU_HZ - this.sampleAcc) / this.sampleRate);
      const step = Math.min(elapsed, toSample, FRAME_SEQ_CYCLES - this.seqAcc);
      elapsed -= step;
      if (this.master) this.runChannels(step);

      this.seqAcc += step;
      if (this.seqAcc >= FRAME_SEQ_CYCLES) {
        this.seqAcc = 0;
        if (this.master) this.clockSequencer();
      }
      this.sampleAcc += step * this.sampleRate;
      if (this.sampleAcc >= CPU_HZ) {
        this.sampleAcc -= CPU_HZ;
        this.emitSample();
      }
    }
  }

  private runChannels(cycles: number): void {
    for (let c = 0; c < 2; c++) {
      if (!this.chOn[c]) continue;
      let t = this.sqTimer[c] - cycles;
      if (t <= 0) {
        const period = (2048 - this.sqFreq[c]) * 16;
        const steps = 1 + Math.floor(-t / period);
        t += steps * period;
        this.sqPhase[c] = (this.sqPhase[c] + steps) & 7;
      }
      this.sqTimer[c] = t;
    }
    if (this.chOn[2]) {
      let t = this.waveTimer - cycles;
      if (t <= 0) {
        const period = (2048 - this.waveFreq) * 8;
        const steps = 1 + Math.floor(-t / period);
        t += steps * period;
        // Bit 5 chains both banks into one 64-sample wave.
        this.wavePos = (this.wavePos + steps) & (this.reg[0x10] & 0x20 ? 63 : 31);
      }
      this.waveTimer = t;
    }
    if (this.chOn[3]) {
      this.noiseTimer -= cycles;
      while (this.noiseTimer <= 0) {
        this.noiseTimer += this.noisePeriod();
        const carry = this.lfsr & 1;
        this.lfsr >>= 1;
        if (carry) this.lfsr ^= this.reg[0x1c] & 8 ? 0x60 : 0x6000;
      }
    }
  }

  /** 512 Hz: length at 256 Hz, sweep at 128 Hz, envelopes at 64 Hz. */
  private clockSequencer(): void {
    const step = this.seqStep;
    this.seqStep = (step + 1) & 7;
    if (!(step & 1)) {
      for (let c = 0; c < 4; c++) {
        if (this.lengthOn[c] && this.length[c] > 0 && --this.length[c] === 0) this.chOn[c] = false;
      }
    }
    if (step === 2 || step === 6) this.clockSweep();
    if (step === 7) {
      this.sqEnv[0].clock(); this.sqEnv[1].clock(); this.noiseEnv.clock();
    }
  }

  private clockSweep(): void {
    if (!this.sweepOn || --this.sweepTimer > 0) return;
    const sweep = this.reg[0x00];
    this.sweepTimer = ((sweep >> 4) & 7) || 8;
    if (!((sweep >> 4) & 7)) return;
    const target = this.sweepTarget();
    if (target > 2047) { this.chOn[0] = false; return; }
    if (sweep & 7) {
      this.sweepShadow = this.sqFreq[0] = target;
      if (this.sweepTarget() > 2047) this.chOn[0] = false;
    }
  }

  // ------------------------------------------------------------------
  // Mixing
  // ------------------------------------------------------------------

  /** Channel output in -15..15. */
  private psgOutput(c: number): number {
    if (!this.chOn[c]) return 0;
    switch (c) {
      case 0: case 1: {
        const high = (DUTY[this.reg[c ? 0x08 : 0x02] >> 6] >> this.sqPhase[c]) & 1;
        return high ? this.sqEnv[c].volume : -this.sqEnv[c].volume;
      }
      case 2: {
        const ctl = this.reg[0x10];
        // Sample index across both banks, starting from the selected one.
        const pos = (this.wavePos + (ctl & 0x40 ? 32 : 0)) & 63;
        const byte = this.waveRam[pos >> 1];
        const nibble = pos & 1 ? byte & 0xf : byte >> 4;
        const vol = this.reg[0x13];
        const scale = vol & 0x80 ? 0.75 : [0, 1, 0.5, 0.25][(vol >> 5) & 3];
        return (nibble * 2 - 15) * scale;
      }
      default:
        return this.lfsr & 1 ? -this.noiseEnv.volume : this.noiseEnv.volume;
    }
  }

  private emitSample(): void {
    let left = 0, right = 0;
    if (this.master) {
      const cntL0 = this.reg[0x20], enables = this.reg[0x21];
      const cntH0 = this.reg[0x22], cntH1 = this.reg[0x23];
      let psgL = 0, psgR = 0;
      for (let c = 0; c < 4; c++) {
        if (!(enables & (0x11 << c))) continue;
        const s = this.psgOutput(c);
        if (enables & (0x01 << c)) psgR += s;
        if (enables & (0x10 << c)) psgL += s;
      }
      // Scale so one full-volume PSG channel spans +-128 of the 10-bit DAC
      // and a full-volume FIFO +-512.
      const psgScale = [0.25, 0.5, 1, 1][cntH0 & 3] * (128 / 15) / 8;
      right = psgR * ((cntL0 & 7) + 1) * psgScale;
      left = psgL * (((cntL0 >> 4) & 7) + 1) * psgScale;
      for (let f = 0; f < 2; f++) {
        const s = this.fifos[f].sample * (cntH0 & (4 << f) ? 4 : 2);
        const route = cntH1 >> (f * 4);
        if (route & 1) right += s;
        if (route & 2) left += s;
      }
    }
    const next = (this.ringW + 2) & (this.ring.length - 1);
    if (next === this.ringR) return; // nobody is draining: drop
    this.ring[this.ringW] = this.filter(0, left);
    this.ring[this.ringW + 1] = this.filter(1, right);
    this.ringW = next;
  }

  /** Clamp to the DAC's range, remove DC, scale to int16. */
  private filter(side: number, v: number): number {
    v = Math.max(-512, Math.min(511, v));
    const out = v - this.hpIn[side] + 0.997 * this.hpOut[side];
    this.hpIn[side] = v;
    this.hpOut[side] = out;
    return Math.max(-32768, Math.min(32767, out * 48)) | 0;
  }

  /** Move buffered samples into `out` (interleaved). Returns values written. */
  drain(out: Int16Array): number {
    let n = 0;
    const mask = this.ring.length - 1;
    while (this.ringR !== this.ringW && n + 2 <= out.length) {
      out[n++] = this.ring[this.ringR];
      out[n++] = this.ring[this.ringR + 1];
      this.ringR = (this.ringR + 2) & mask;
    }
    return n;
  }

  /** Discard buffered output (fast-forward, rewind, state loads). */
  clearOutput(): void {
    this.ringR = this.ringW;
  }

  // ------------------------------------------------------------------
  // Save states
  // ------------------------------------------------------------------

  saveState(w: StateWriter): void {
    w.f64(this.sampleAcc); w.i32(this.seqAcc); w.u8(this.seqStep);
    w.bytes(this.reg); w.bool(this.master);
    for (let c = 0; c < 4; c++) { w.bool(this.chOn[c]); w.bool(this.lengthOn[c]); }
    w.array(this.length);
    this.sqEnv[0].save(w); this.sqEnv[1].save(w); this.noiseEnv.save(w);
    w.array(this.sqFreq); w.array(this.sqTimer); w.array(this.sqPhase);
    w.i32(this.sweepShadow); w.i32(this.sweepTimer); w.bool(this.sweepOn);
    w.bytes(this.waveRam); w.i32(this.waveFreq); w.i32(this.waveTimer); w.i32(this.wavePos);
    w.i32(this.lfsr); w.i32(this.noiseTimer);
    this.fifos[0].save(w); this.fifos[1].save(w);
  }

  loadState(r: StateReader): void {
    this.sampleAcc = r.f64(); this.seqAcc = r.i32(); this.seqStep = r.u8();
    r.bytesInto(this.reg); this.master = r.bool();
    for (let c = 0; c < 4; c++) { this.chOn[c] = r.bool(); this.lengthOn[c] = r.bool(); }
    r.arrayInto(this.length);
    this.sqEnv[0].load(r); this.sqEnv[1].load(r); this.noiseEnv.load(r);
    r.arrayInto(this.sqFreq); r.arrayInto(this.sqTimer); r.arrayInto(this.sqPhase);
    this.sweepShadow = r.i32(); this.sweepTimer = r.i32(); this.sweepOn = r.bool();
    r.bytesInto(this.waveRam); this.waveFreq = r.i32(); this.waveTimer = r.i32(); this.wavePos = r.i32();
    this.lfsr = r.i32(); this.noiseTimer = r.i32();
    this.fifos[0].load(r); this.fifos[1].load(r);
    this.clearOutput();
  }
}
