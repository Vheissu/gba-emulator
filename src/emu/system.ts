// System-level IO: timers, DMA, interrupt controller, keypad, serial
// (stubbed), waitstate control, halt control.

import { Bus, BusDevice } from "./bus";
import { CPU } from "./cpu";
import { APU } from "./apu";

const PRESCALER = [1, 64, 256, 1024];

export class System implements BusDevice {
  bus!: Bus;
  cpu!: CPU;
  apu!: APU;

  // Interrupts
  ie = 0;
  if_ = 0;
  ime = 0;

  // Timers
  tmReload = new Uint16Array(4);
  tmCounter = new Uint16Array(4);
  tmCnt = new Uint16Array(4);
  private tmAcc = new Float64Array(4);

  // DMA
  dmaSad = new Uint32Array(4);
  dmaDad = new Uint32Array(4);
  dmaCntL = new Uint16Array(4);
  dmaCntH = new Uint16Array(4);
  // internal working regs
  private dmaSrc = new Uint32Array(4);
  private dmaDst = new Uint32Array(4);
  private dmaRunning = [false, false, false, false];

  // Keypad
  keyinput = 0x3ff;
  keycnt = 0;

  // Serial (stubbed; enough to keep single-player games happy)
  private siocnt = 0;
  private siodata = 0;
  private rcnt = 0;
  private joycnt = 0;
  private joyRecv = 0;
  private joySend = 0;
  private joyStat = 0;

  waitcnt = 0;
  postflg = 0;

  onFrameSync: () => void = () => {};
  onIrqFired: () => void = () => {};

  irqLine(): boolean {
    return this.ime === 1 && (this.ie & this.if_) !== 0;
  }

  /** CPU wakes from HALT on any IE&IF match, regardless of IME. */
  haltWake(): boolean {
    return (this.ie & this.if_) !== 0;
  }

  requestIrq(bit: number): void {
    this.if_ |= 1 << bit;
    this.onIrqFired();
  }

  keyChanged(): void {
    const pressed = (~this.keyinput) & 0x3ff;
    const sel = this.keycnt & 0x3ff;
    let fire = false;
    if (this.keycnt & 0x4000) {
      if (this.keycnt & 0x8000) fire = (pressed & sel) === sel;   // AND
      else fire = (pressed & sel) !== 0;                          // OR
    }
    if (fire) this.requestIrq(12);
  }

  // ------------------------------------------------------------------
  // Timers
  // ------------------------------------------------------------------

  advance(elapsed: number): void {
    for (let t = 0; t < 4; t++) {
      const cnt = this.tmCnt[t];
      if (!(cnt & 0x80) || (cnt & 0x04)) continue; // disabled or cascade
      this.tmAcc[t] += elapsed;
      const period = PRESCALER[cnt & 3];
      while (this.tmAcc[t] >= period) {
        this.tmAcc[t] -= period;
        this.tickTimer(t);
      }
    }
  }

  private tickTimer(t: number): void {
    let v = this.tmCounter[t] + 1;
    if (v > 0xffff) {
      v = this.tmReload[t];
      if (this.tmCnt[t] & 0x40) this.requestIrq(3 + t);
      this.apu.timerOverflow(t);
      // Cascade into the next timer.
      const nxt = this.tmCnt[t + 1];
      if (t < 3 && nxt !== undefined && (nxt & 0x84) === 0x84) {
        this.tickTimer(t + 1);
      }
    }
    this.tmCounter[t] = v;
  }

  // ------------------------------------------------------------------
  // DMA
  // ------------------------------------------------------------------

  private dmaMaxCount(ch: number): number {
    const max = ch === 3 ? 0x10000 : 0x4000;
    return this.dmaCntL[ch] % max === 0 ? max : this.dmaCntL[ch] % max;
  }

  private dmaEnable(ch: number): void {
    const timing = (this.dmaCntH[ch] >>> 12) & 3;
    if (timing === 0) this.runDMA(ch);
    else this.dmaRunning[ch] = true;
  }

  /** HBlank / VBlank / FIFO triggers. kind: 1=vblank 2=hblank 3=fifoA/B */
  dmaTrigger(kind: number, fifo = -1): void {
    for (let ch = 0; ch < 4; ch++) {
      if (!this.dmaRunning[ch]) continue;
      if (!(this.dmaCntH[ch] & 0x8000)) { this.dmaRunning[ch] = false; continue; }
      const timing = (this.dmaCntH[ch] >>> 12) & 3;
      if (timing !== kind) continue;
      if (kind === 3) {
        // Sound FIFO mode: only ch1/2 respond; ch3's special mode is
        // GamePak DRQ (unsupported, never fires).
        if (ch === 0 || ch === 3) continue;
        const isA = ch === 1;
        if ((fifo === 0) !== isA) continue;
        this.runFifoDMA(ch);
      } else {
        this.runDMA(ch);
      }
    }
  }

  private runFifoDMA(ch: number): void {
    // FIFO mode: always 4 words (32-bit) to the fixed FIFO register.
    let src = this.dmaSrc[ch];
    const dad = this.dmaDad[ch];
    const sadAdj = (this.dmaCntH[ch] >>> 7) & 3;
    for (let i = 0; i < 4; i++) {
      const v = this.bus.rawRead32ForDma(src);
      this.bus.write32Seq(dad, v);
      src = this.adjustSrc(src, sadAdj);
    }
    this.dmaSrc[ch] = src;
  }

  private adjustSrc(src: number, adj: number): number {
    switch (adj) {
      case 0: case 3: return (src + 4) >>> 0;
      case 1: return (src - 4) >>> 0;
      default: return src;
    }
  }

  private runDMA(ch: number): void {
    const cntH = this.dmaCntH[ch];
    const is32 = (cntH & 0x0400) !== 0;
    const dadAdj = (cntH >>> 5) & 3;
    const sadAdj = (cntH >>> 7) & 3;
    const repeat = (cntH & 0x0200) !== 0;
    const timing = (cntH >>> 12) & 3;

    let src = this.dmaSrc[ch];
    let dst = this.dmaDst[ch];
    // Every trigger transfers the full word count.
    const count = this.dmaMaxCount(ch);

    const step = is32 ? 4 : 2;
    for (let i = 0; i < count; i++) {
      if (is32) {
        const v = this.bus.rawRead32ForDma(src);
        if (i === 0) this.bus.write32(dst, v);
        else this.bus.write32Seq(dst, v);
      } else {
        const v = this.bus.rawRead16ForDma(src);
        if (i === 0) this.bus.write16(dst, v);
        else this.bus.write16Seq(dst, v);
      }
      // src adjust
      switch (sadAdj) {
        case 0: case 3: src = (src + step) >>> 0; break;
        case 1: src = (src - step) >>> 0; break;
        default: break;
      }
      // dst adjust (3 = increment + reload at end)
      switch (dadAdj) {
        case 0: case 3: dst = (dst + step) >>> 0; break;
        case 1: dst = (dst - step) >>> 0; break;
        default: break;
      }
    }

    if (dadAdj === 3) dst = this.dmaDad[ch];
    this.dmaSrc[ch] = src;
    this.dmaDst[ch] = dst;

    if (cntH & 0x4000) this.requestIrq(8 + ch);

    if (timing === 0 || !repeat) {
      // Done: clear enable.
      this.dmaCntH[ch] &= 0x7fff;
      this.dmaRunning[ch] = false;
    }
    this.bus.internal(2);
  }

  // ------------------------------------------------------------------
  // IO dispatch
  // ------------------------------------------------------------------

  ioRead(off: number): number {
    switch (true) {
      case off >= 0x100 && off <= 0x10e: {
        const t = (off - 0x100) >> 2;
        return (off & 2) ? this.tmCnt[t] : this.tmCounter[t];
      }
      case off >= 0xb0 && off <= 0xdf: {
        const ch = Math.floor((off - 0xb0) / 12);
        const sub = (off - 0xb0) % 12;
        if (sub === 8) return this.dmaCntL[ch];
        if (sub === 10) return this.dmaCntH[ch];
        return -1; // SAD/DAD write-only
      }
      case off === 0x120: return this.siocnt;
      case off === 0x122: return 0; // SIODATA8/32 low
      case off === 0x124: case off === 0x126: case off === 0x128: case off === 0x12a: return this.siodata;
      case off === 0x12c: return 0; // SIOMLT_SEND
      case off === 0x130: return this.keyinput;
      case off === 0x132: return this.keycnt;
      case off === 0x134: return this.rcnt;
      case off === 0x140: return this.joycnt;
      case off === 0x150: return this.joyRecv;
      case off === 0x154: return this.joyStat;
      case off === 0x158: return this.joySend;
      case off === 0x200: return this.ie;
      case off === 0x202: return this.if_;
      case off === 0x204: return this.waitcnt;
      case off === 0x208: return this.ime;
      case off === 0x300: return this.postflg;
    }
    return -1;
  }

  ioWrite(off: number, value: number): void {
    switch (true) {
      case off >= 0x100 && off <= 0x10e: {
        const t = (off - 0x100) >> 2;
        if (off & 2) {
          const wasOn = (this.tmCnt[t] & 0x80) !== 0;
          this.tmCnt[t] = value;
          if (!wasOn && (value & 0x80)) {
            this.tmCounter[t] = this.tmReload[t];
            this.tmAcc[t] = 0;
          }
        } else {
          this.tmReload[t] = value;
        }
        return;
      }
      case off >= 0xb0 && off <= 0xdf: {
        const ch = Math.floor((off - 0xb0) / 12);
        const sub = (off - 0xb0) % 12;
        const mask = [0x07ffffff, 0x0fffffff, 0x0fffffff, 0x0fffffff][ch];
        const dmask = [0x07ffffff, 0x07ffffff, 0x07ffffff, 0x0fffffff][ch];
        switch (sub) {
          case 0: this.dmaSad[ch] = (this.dmaSad[ch] & ~0xffff) | value; break;
          case 2: this.dmaSad[ch] = ((this.dmaSad[ch] & 0xffff) | (value << 16)) & mask; break;
          case 4: this.dmaDad[ch] = (this.dmaDad[ch] & ~0xffff) | value; break;
          case 6: this.dmaDad[ch] = ((this.dmaDad[ch] & 0xffff) | (value << 16)) & dmask; break;
          case 8: this.dmaCntL[ch] = value; break;
          case 10: {
            const wasOn = (this.dmaCntH[ch] & 0x8000) !== 0;
            this.dmaCntH[ch] = value;
            if (!wasOn && (value & 0x8000)) {
              this.dmaSrc[ch] = this.dmaSad[ch];
              this.dmaDst[ch] = this.dmaDad[ch];
              this.dmaEnable(ch);
            }
            break;
          }
        }
        return;
      }
      case off === 0x120: this.siocnt = value; return;
      case off === 0x128: this.siodata = value; return;
      case off === 0x130: return; // KEYINPUT read-only
      case off === 0x132: this.keycnt = value; this.keyChanged(); return;
      case off === 0x134: this.rcnt = value; return;
      case off === 0x140: this.joycnt = value; return;
      case off === 0x150: this.joyRecv = value; return;
      case off === 0x158: this.joySend = value; return;
      case off === 0x200: this.ie = value; return;
      case off === 0x202: this.if_ &= ~value; return; // write-1-to-clear
      case off === 0x204: this.waitcnt = value; return;
      case off === 0x208: this.ime = value & 1; return;
      case off === 0x300: this.postflg = value & 1; return;
      case off === 0x301:
        if ((value & 0xff) === 0) this.cpu.halted = true;   // HALT
        else this.cpu.halted = true;                         // STOP ~ HALT for our purposes
        return;
    }
  }
}
