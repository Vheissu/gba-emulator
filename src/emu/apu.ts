// GBA APU: 4 PSG channels (2 square, 1 wave, 1 noise) + 2 FIFO direct
// sound channels. Mixed to stereo int16 at the host sample rate.

import { BusDevice } from "./bus";

const CPU_HZ = 16777216;
const LEN_CLOCK = CPU_HZ / 256;   // length counter
const ENV_CLOCK = CPU_HZ / 64;    // envelope
const SWP_CLOCK = CPU_HZ / 128;   // sweep

const DUTY = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
];
const NOISE_DIV = [8, 16, 32, 48, 64, 80, 96, 112];

export class APU implements BusDevice {
  sampleRate = 48000;
  private cyclesPerSample = CPU_HZ / this.sampleRate;
  private sampleAcc = 0;

  // Output ring buffer (interleaved int16 stereo).
  private bufCap = 1 << 14;
  private buf = new Int16Array(this.bufCap);
  private bufR = 0;
  private bufW = 0;

  enabled = true;

  // ---- PSG channel state ----
  private chLen = [0, 0, 0, 0];
  private chOn = [false, false, false, false];

  // ch1/ch2 square
  private sqDuty = [0, 0];
  private sqStep = [0, 0];
  private sqTimer = [0, 0];
  private sqFreq = [0, 0];
  private sqVol = [0, 0];
  private sqEnvDir = [0, 0];
  private sqEnvPer = [0, 0];
  private sqEnvT = [0, 0];
  private sqLenEn = [false, false];

  // ch1 sweep
  private swpPer = 0;
  private swpDir = 0;
  private swpShift = 0;
  private swpT = 0;
  private swpFreq = 0;

  // ch3 wave
  private waveRAM = new Uint8Array(0x20);
  private waveBank = 0;
  private waveDac = false;
  private waveVol = 0;
  private waveForce75 = false;
  private waveFreq = 0;
  private wavePos = 0;
  private waveTimer = 0;
  private waveLenEn = false;

  // ch4 noise
  private noiseVol = 0;
  private noiseEnvDir = 0;
  private noiseEnvPer = 0;
  private noiseEnvT = 0;
  private noiseDiv = 0;
  private noiseShift = 0;
  private noise7 = false;
  private noiseLfsr = 0x7fff;
  private noiseTimer = 0;
  private noiseLenEn = false;

  // ---- SOUNDCNT ----
  private cntL = 0;
  private cntH = 0;
  private cntX = 0;
  private bias = 0;

  // ---- FIFOs ----
  fifoA = new Int8Array(32);
  fifoB = new Int8Array(32);
  private fifoALen = 0;
  private fifoBLen = 0;
  private fifoAHead = 0;
  private fifoBHead = 0;
  private fifoASample = 0;
  private fifoBSample = 0;

  /** Called when a timer overflows; 0 or 1. */
  onTimerOverflow: (tmr: number) => void = () => {};
  /** Called when a FIFO wants more data (returns true for each). */
  fifoARequest: () => void = () => {};
  fifoBRequest: () => void = () => {};

  private lenAcc = 0;
  private envAcc = 0;
  private swpAcc = 0;

  reset(): void {
    this.bufR = this.bufW = 0;
    this.sampleAcc = 0;
    this.fifoALen = this.fifoBLen = 0;
    this.fifoAHead = this.fifoBHead = 0;
    this.chOn = [false, false, false, false];
    this.cntL = this.cntH = this.cntX = 0;
    this.waveRAM.fill(0);
  }

  // ------------------------------------------------------------------
  // IO
  // ------------------------------------------------------------------

  ioRead(off: number): number {
    switch (off) {
      case 0x60: return (this.swpPer << 4) | (this.swpDir ? 8 : 0) | this.swpShift;
      case 0x62: return (this.sqDuty[0] << 6) | (this.chLen[0] & 0x3f);
      case 0x63: return (this.sqVol[0] << 4) | (this.sqEnvDir[0] ? 8 : 0) | this.sqEnvPer[0];
      case 0x64: return (this.sqLenEn[0] ? 0x40 : 0);
      case 0x68: return (this.sqDuty[1] << 6) | (this.chLen[1] & 0x3f);
      case 0x69: return (this.sqVol[1] << 4) | (this.sqEnvDir[1] ? 8 : 0) | this.sqEnvPer[1];
      case 0x6c: return this.sqLenEn[1] ? 0x40 : 0;
      case 0x70: return (this.waveBank << 6) | (this.waveDac ? 0x80 : 0);
      case 0x72: return (this.waveVol << 5) | (this.waveForce75 ? 0x80 : 0);
      case 0x74: return this.waveLenEn ? 0x40 : 0;
      case 0x78: return this.chLen[3] & 0x3f;
      case 0x79: return (this.noiseVol << 4) | (this.noiseEnvDir ? 8 : 0) | this.noiseEnvPer;
      case 0x7c: return this.noiseLenEn ? 0x40 : 0;
      case 0x80: return this.cntL;
      case 0x82: return this.cntH;
      case 0x84: return this.cntX | (this.chOn[0] ? 1 : 0) | (this.chOn[1] ? 2 : 0) |
        (this.chOn[2] ? 4 : 0) | (this.chOn[3] ? 8 : 0);
      case 0x88: return this.bias;
      case 0x90: case 0x92: case 0x94: case 0x96:
      case 0x98: case 0x9a: case 0x9c: case 0x9e: {
        const o = off - 0x90;
        return this.waveRAM[o] | (this.waveRAM[o + 1] << 8);
      }
    }
    return -1;
  }

  ioWrite(off: number, value: number): void {
    switch (off) {
      case 0x60:
        this.swpPer = (value >>> 4) & 7;
        this.swpDir = (value >>> 3) & 1;
        this.swpShift = value & 7;
        return;
      case 0x62:
        this.chLen[0] = 64 - (value & 0x3f);
        this.sqDuty[0] = (value >>> 6) & 3;
        return;
      case 0x63:
        this.sqVol[0] = (value >>> 4) & 0xf;
        this.sqEnvDir[0] = (value >>> 3) & 1;
        this.sqEnvPer[0] = value & 7;
        if ((value & 0xf8) === 0) this.chOn[0] = false; // DAC off
        return;
      case 0x64:
        this.sqLenEn[0] = (value & 0x40) !== 0;
        this.sqFreq[0] = (this.sqFreq[0] & ~0x700) | (value & 7) << 8 | (this.sqFreq[0] & 0xff);
        this.sqFreq[0] = (this.sqFreq[0] & 0xff) | ((value & 7) << 8);
        if (value & 0x80) this.trigger(0);
        return;
      case 0x68:
        this.chLen[1] = 64 - (value & 0x3f);
        this.sqDuty[1] = (value >>> 6) & 3;
        return;
      case 0x69:
        this.sqVol[1] = (value >>> 4) & 0xf;
        this.sqEnvDir[1] = (value >>> 3) & 1;
        this.sqEnvPer[1] = value & 7;
        if ((value & 0xf8) === 0) this.chOn[1] = false;
        return;
      case 0x6c:
        this.sqLenEn[1] = (value & 0x40) !== 0;
        this.sqFreq[1] = (this.sqFreq[1] & 0xff) | ((value & 7) << 8);
        if (value & 0x80) this.trigger(1);
        return;
      case 0x70:
        this.waveBank = (value >>> 6) & 1;
        this.waveDac = (value & 0x80) !== 0;
        if (!this.waveDac) this.chOn[2] = false;
        return;
      case 0x72:
        this.chLen[2] = 256 - (value & 0xff);
        this.waveVol = (value >>> 5) & 3;
        this.waveForce75 = (value & 0x80) !== 0;
        return;
      case 0x74:
        this.waveLenEn = (value & 0x40) !== 0;
        this.waveFreq = (this.waveFreq & 0xff) | ((value & 7) << 8);
        if (value & 0x80) this.trigger(2);
        return;
      case 0x78:
        this.chLen[3] = 64 - (value & 0x3f);
        return;
      case 0x79:
        this.noiseVol = (value >>> 4) & 0xf;
        this.noiseEnvDir = (value >>> 3) & 1;
        this.noiseEnvPer = value & 7;
        if ((value & 0xf8) === 0) this.chOn[3] = false;
        return;
      case 0x7c:
        this.noiseLenEn = (value & 0x40) !== 0;
        this.noiseDiv = value & 7;
        this.noise7 = (value & 8) !== 0;
        this.noiseShift = (value >>> 4) & 0xf;
        if (value & 0x80) this.trigger(3);
        return;
      case 0x80:
        this.cntL = value;
        return;
      case 0x82:
        this.cntH = value;
        if (value & 0x800) this.fifoALen = this.fifoAHead = 0;
        if (value & 0x8000) this.fifoBLen = this.fifoBHead = 0;
        return;
      case 0x84:
        this.cntX = value & 0x80;
        if (!(value & 0x80)) this.chOn = [false, false, false, false];
        return;
      case 0x88:
        this.bias = value & 0x3ff;
        return;
      // FIFO writes: a 16-bit write pushes 2 bytes, a 32-bit write lands
      // as two 16-bit ioWrites (0xa0 + 0xa2).
      case 0xa0: case 0xa2:
        this.fifoPush(this.fifoA, 0, value & 0xff);
        this.fifoPush(this.fifoA, 0, (value >>> 8) & 0xff);
        return;
      case 0xa1: case 0xa3:
        this.fifoPush(this.fifoA, 0, value & 0xff);
        return;
      case 0xa4: case 0xa6:
        this.fifoPush(this.fifoB, 1, value & 0xff);
        this.fifoPush(this.fifoB, 1, (value >>> 8) & 0xff);
        return;
      case 0xa5: case 0xa7:
        this.fifoPush(this.fifoB, 1, value & 0xff);
        return;
      default:
        if (off >= 0x90 && off <= 0x9f) {
          this.waveRAM[off - 0x90] = value & 0xff;
          this.waveRAM[off - 0x90 + 1] = (value >>> 8) & 0xff;
        }
        return;
    }
  }

  /** Handle a 32-bit FIFO write (called by DMA / CPU write32). */
  fifoWrite32(fifo: number, value: number): void {
    const f = fifo === 0 ? this.fifoA : this.fifoB;
    this.fifoPush(f, fifo, value & 0xff);
    this.fifoPush(f, fifo, (value >>> 8) & 0xff);
    this.fifoPush(f, fifo, (value >>> 16) & 0xff);
    this.fifoPush(f, fifo, value >>> 24);
  }

  private fifoPush(f: Int8Array, which: number, v: number): void {
    const len = which === 0 ? this.fifoALen : this.fifoBLen;
    if (len >= 32) return;
    const head = which === 0 ? this.fifoAHead : this.fifoBHead;
    f[(head + len) & 31] = v;
    if (which === 0) this.fifoALen++; else this.fifoBLen++;
  }

  /** Timer overflow pops FIFO samples (called by the timer unit). */
  timerOverflow(t: number): void {
    // SOUNDCNT_H bits 10/14 select the timer (0 or 1) for each FIFO.
    if (t === ((this.cntH >>> 10) & 1)) {
      if (this.fifoALen > 0) {
        this.fifoASample = this.fifoA[this.fifoAHead];
        this.fifoAHead = (this.fifoAHead + 1) & 31;
        this.fifoALen--;
        if (this.fifoALen <= 16) this.fifoARequest();
      }
    }
    if (t === ((this.cntH >>> 14) & 1)) {
      if (this.fifoBLen > 0) {
        this.fifoBSample = this.fifoB[this.fifoBHead];
        this.fifoBHead = (this.fifoBHead + 1) & 31;
        this.fifoBLen--;
        if (this.fifoBLen <= 16) this.fifoBRequest();
      }
    }
  }

  fifoNeedsA(): boolean { return this.fifoALen <= 16; }
  fifoNeedsB(): boolean { return this.fifoBLen <= 16; }

  // ------------------------------------------------------------------
  // Channel trigger / frame events
  // ------------------------------------------------------------------

  private trigger(ch: number): void {
    if (!(this.cntX & 0x80)) return;
    switch (ch) {
      case 0:
        this.chOn[0] = (this.sqEnvPer[0] | this.sqVol[0] | this.sqEnvDir[0]) !== 0 || true;
        this.chOn[0] = true;
        this.sqStep[0] = 0;
        this.sqTimer[0] = (2048 - this.sqFreq[0]) * 4;
        this.sqEnvT[0] = this.sqEnvPer[0];
        this.swpT = this.swpPer;
        this.swpFreq = this.sqFreq[0];
        if (this.chLen[0] === 0) this.chLen[0] = 64;
        break;
      case 1:
        this.chOn[1] = true;
        this.sqStep[1] = 0;
        this.sqTimer[1] = (2048 - this.sqFreq[1]) * 4;
        this.sqEnvT[1] = this.sqEnvPer[1];
        if (this.chLen[1] === 0) this.chLen[1] = 64;
        break;
      case 2:
        this.chOn[2] = this.waveDac;
        this.wavePos = 0;
        this.waveTimer = (2048 - this.waveFreq) * 2;
        if (this.chLen[2] === 0) this.chLen[2] = 256;
        break;
      case 3:
        this.chOn[3] = true;
        this.noiseLfsr = this.noise7 ? 0x7f : 0x7fff;
        this.noiseTimer = NOISE_DIV[this.noiseDiv] << this.noiseShift;
        this.noiseEnvT = this.noiseEnvPer;
        if (this.chLen[3] === 0) this.chLen[3] = 64;
        break;
    }
  }

  advance(elapsed: number): void {
    if (!(this.cntX & 0x80)) {
      // Sound off: still drain sample timing so the output stream stays synced.
      this.sampleAcc += elapsed;
      while (this.sampleAcc >= this.cyclesPerSample) {
        this.sampleAcc -= this.cyclesPerSample;
        this.pushSample(0, 0);
      }
      return;
    }
    this.stepChannels(elapsed);

    // Event clocks
    this.lenAcc += elapsed;
    while (this.lenAcc >= LEN_CLOCK) {
      this.lenAcc -= LEN_CLOCK;
      this.clockLength();
    }
    this.envAcc += elapsed;
    while (this.envAcc >= ENV_CLOCK) {
      this.envAcc -= ENV_CLOCK;
      this.clockEnvelope();
    }
    this.swpAcc += elapsed;
    while (this.swpAcc >= SWP_CLOCK) {
      this.swpAcc -= SWP_CLOCK;
      this.clockSweep();
    }

    // Sampling
    this.sampleAcc += elapsed;
    while (this.sampleAcc >= this.cyclesPerSample) {
      this.sampleAcc -= this.cyclesPerSample;
      const [l, r] = this.mix();
      this.pushSample(l, r);
    }
  }

  private stepChannels(elapsed: number): void {
    // Square channels
    for (let c = 0; c < 2; c++) {
      if (!this.chOn[c]) continue;
      this.sqTimer[c] -= elapsed;
      while (this.sqTimer[c] <= 0) {
        this.sqTimer[c] += (2048 - this.sqFreq[c]) * 4;
        this.sqStep[c] = (this.sqStep[c] + 1) & 7;
      }
    }
    // Wave channel
    if (this.chOn[2]) {
      this.waveTimer -= elapsed;
      while (this.waveTimer <= 0) {
        this.waveTimer += (2048 - this.waveFreq) * 2;
        this.wavePos = (this.wavePos + 1) & 31;
      }
    }
    // Noise channel
    if (this.chOn[3]) {
      this.noiseTimer -= elapsed;
      while (this.noiseTimer <= 0) {
        this.noiseTimer += NOISE_DIV[this.noiseDiv] << this.noiseShift;
        const lsb = this.noiseLfsr & 1;
        this.noiseLfsr >>= 1;
        if (lsb) {
          this.noiseLfsr ^= this.noise7 ? 0x60 : 0x6000;
        }
      }
    }
  }

  private clockLength(): void {
    for (let c = 0; c < 4; c++) {
      const en = c === 0 ? this.sqLenEn[0] : c === 1 ? this.sqLenEn[1] :
        c === 2 ? this.waveLenEn : this.noiseLenEn;
      if (en && this.chLen[c] > 0 && this.chOn[c]) {
        if (--this.chLen[c] === 0) this.chOn[c] = false;
      }
    }
  }

  private clockEnvelope(): void {
    for (let c = 0; c < 2; c++) {
      if (this.sqEnvPer[c] && this.chOn[c] && --this.sqEnvT[c] <= 0) {
        this.sqEnvT[c] = this.sqEnvPer[c];
        const nv = this.sqVol[c] + (this.sqEnvDir[c] ? 1 : -1);
        if (nv >= 0 && nv <= 15) this.sqVol[c] = nv;
      }
    }
    if (this.noiseEnvPer && this.chOn[3] && --this.noiseEnvT <= 0) {
      this.noiseEnvT = this.noiseEnvPer;
      const nv = this.noiseVol + (this.noiseEnvDir ? 1 : -1);
      if (nv >= 0 && nv <= 15) this.noiseVol = nv;
    }
  }

  private clockSweep(): void {
    if (!this.swpPer || !this.chOn[0]) return;
    if (--this.swpT > 0) return;
    this.swpT = this.swpPer;
    const delta = this.swpFreq >> this.swpShift;
    const nf = this.swpDir ? this.swpFreq - delta : this.swpFreq + delta;
    if (nf > 2047) { this.chOn[0] = false; return; }
    if (this.swpShift) {
      this.swpFreq = nf;
      this.sqFreq[0] = nf;
      const n2 = nf + (nf >> this.swpShift) * (this.swpDir ? -1 : 1);
      if (n2 > 2047) this.chOn[0] = false;
    }
  }

  // ------------------------------------------------------------------
  // Mixing
  // ------------------------------------------------------------------

  private mix(): [number, number] {
    const cntL = this.cntL;
    const cntH = this.cntH;
    const psgVol = [4, 2, 1, 1][cntH & 3]; // 25%,50%,100%,(100%)
    const rightVol = ((cntL & 7) + 1) / 8;
    const leftVol = (((cntL >>> 4) & 7) + 1) / 8;
    const en = (cntL >>> 8) & 0xff; // [0-3] right, [4-7] left

    let right = 0, left = 0;
    for (let c = 0; c < 4; c++) {
      if (!this.chOn[c]) continue;
      let s = 0;
      switch (c) {
        case 0:
        case 1:
          s = DUTY[this.sqDuty[c]][this.sqStep[c]] ? this.sqVol[c] : -this.sqVol[c];
          break;
        case 2: {
          const b = this.waveRAM[(this.waveBank << 4) + (this.wavePos >> 1)];
          const nib = (this.wavePos & 1) ? b >>> 4 : b & 0xf;
          const shift = this.waveForce75 ? 0 : [4, 0, 1, 2][this.waveVol];
          s = (nib - 8) * (this.waveForce75 ? 0.75 * 2 : 2) / (1 << shift) * (15 / 16);
          if (this.waveVol === 0 && !this.waveForce75) s = 0;
          break;
        }
        case 3:
          s = (this.noiseLfsr & 1) === 0 ? this.noiseVol : -this.noiseVol;
          break;
      }
      s /= psgVol;
      if (en & (1 << c)) right += s;
      if (en & (0x10 << c)) left += s;
    }

    // PSG range ~ +-15 per channel (4 ch) -> scale to a decent range.
    right = right * rightVol * 256;
    left = left * leftVol * 256;

    // FIFO direct sound (already 8-bit signed).
    const dsaVol = (cntH & 4) ? 1 : 0.5;
    const dsbVol = (cntH & 8) ? 1 : 0.5;
    if (cntH & 0x100) right += this.fifoASample * 256 * dsaVol;
    if (cntH & 0x200) left += this.fifoASample * 256 * dsaVol;
    if (cntH & 0x1000) right += this.fifoBSample * 256 * dsbVol;
    if (cntH & 0x2000) left += this.fifoBSample * 256 * dsbVol;

    const l = Math.max(-32768, Math.min(32767, left * 0.7));
    const r = Math.max(-32768, Math.min(32767, right * 0.7));
    return [l | 0, r | 0];
  }

  private pushSample(l: number, r: number): void {
    const next = (this.bufW + 2) & (this.bufCap - 1);
    if (next === this.bufR) return; // overflow: drop
    this.buf[this.bufW] = l;
    this.buf[this.bufW + 1] = r;
    this.bufW = next;
  }

  /** Drain available samples into `out` (interleaved). Returns count. */
  drain(out: Int16Array): number {
    let n = 0;
    while (this.bufR !== this.bufW && n + 2 <= out.length) {
      out[n++] = this.buf[this.bufR];
      this.bufR = (this.bufR + 1) & (this.bufCap - 1);
      out[n++] = this.buf[this.bufR];
      this.bufR = (this.bufR + 1) & (this.bufCap - 1);
    }
    return n;
  }
}
