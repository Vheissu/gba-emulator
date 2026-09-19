// System-level IO: timers, DMA, interrupt controller, keypad, serial
// (stubbed), waitstate control, halt control.

import type { Bus } from "./bus";
import type { CPU } from "./cpu";
import type { APU } from "./apu";
import type { StateReader, StateWriter } from "./state";

export const IRQ_VBLANK = 0;
export const IRQ_HBLANK = 1;
export const IRQ_VCOUNT = 2;
export const IRQ_TIMER0 = 3;
export const IRQ_DMA0 = 8;
export const IRQ_KEYPAD = 12;

export const enum DmaTiming { Immediate, VBlank, HBlank, Special }

const PRESCALER_SHIFT = [0, 6, 8, 10];
const TIMER_ENABLE = 0x80;
const TIMER_IRQ = 0x40;
const TIMER_CASCADE = 0x04;

const DMA_ENABLE = 0x8000;
const DMA_SRC_MASK = [0x07ffffff, 0x0fffffff, 0x0fffffff, 0x0fffffff];
const DMA_DST_MASK = [0x07ffffff, 0x07ffffff, 0x07ffffff, 0x0fffffff];

export class System {
  bus!: Bus;
  cpu!: CPU;
  apu!: APU;

  // Interrupts
  private ie = 0;
  private if_ = 0;
  private ime = 0;

  // Timers
  private tmReload = new Uint16Array(4);
  private tmCounter = new Int32Array(4);
  private tmCnt = new Uint16Array(4);
  /** Cycles accumulated towards the next prescaler tick. */
  private tmAcc = new Int32Array(4);

  // DMA: registers as written, plus the internal working copies.
  private dmaSad = new Uint32Array(4);
  private dmaDad = new Uint32Array(4);
  private dmaCntL = new Uint16Array(4);
  private dmaCntH = new Uint16Array(4);
  private dmaSrc = new Uint32Array(4);
  private dmaDst = new Uint32Array(4);

  // Keypad
  private keyinput = 0x3ff;
  private keycnt = 0;

  // Serial: just enough register storage to keep single-player games happy.
  private siocnt = 0;
  private siodata = 0;
  private rcnt = 0x8000;
  private joycnt = 0;
  private joyRecv = 0;
  private joySend = 0;

  private waitcnt = 0;
  private postflg = 0;

  reset(): void {
    this.ie = this.if_ = this.ime = 0;
    this.tmReload.fill(0); this.tmCounter.fill(0); this.tmCnt.fill(0); this.tmAcc.fill(0);
    this.dmaSad.fill(0); this.dmaDad.fill(0); this.dmaCntL.fill(0); this.dmaCntH.fill(0);
    this.dmaSrc.fill(0); this.dmaDst.fill(0);
    this.keyinput = 0x3ff;
    this.keycnt = 0;
    this.siocnt = this.siodata = this.joycnt = this.joyRecv = this.joySend = 0;
    this.rcnt = 0x8000;
    this.waitcnt = 0;
    this.postflg = 0;
    this.updateIrqLine();
  }

  // ------------------------------------------------------------------
  // Interrupts
  // ------------------------------------------------------------------

  requestIrq(bit: number): void {
    this.if_ |= 1 << bit;
    this.updateIrqLine();
  }

  /** HLE IntrWait forces the master enable on, like the real routine. */
  enableMaster(): void {
    this.ime = 1;
    this.updateIrqLine();
  }

  /** HALT, unless an enabled interrupt is already waiting. */
  halt(): void {
    if ((this.ie & this.if_) === 0) this.cpu.halted = true;
  }

  private updateIrqLine(): void {
    const pending = (this.ie & this.if_) !== 0;
    // HALT ends on any enabled interrupt, even with IME clear.
    if (pending) this.cpu.halted = false;
    this.cpu.irqLine = pending && this.ime === 1;
  }

  // ------------------------------------------------------------------
  // Keypad
  // ------------------------------------------------------------------

  /** `pressed`: bit set = button down (A B Sel Start R L U D R-sh L-sh). */
  setKeys(pressed: number): void {
    const next = ~pressed & 0x3ff;
    if (next === this.keyinput) return;
    this.keyinput = next;
    this.checkKeypadIrq();
  }

  private checkKeypadIrq(): void {
    if (!(this.keycnt & 0x4000)) return;
    const pressed = ~this.keyinput & 0x3ff;
    const sel = this.keycnt & 0x3ff;
    const fire = this.keycnt & 0x8000 ? (pressed & sel) === sel : (pressed & sel) !== 0;
    if (fire) this.requestIrq(IRQ_KEYPAD);
  }

  // ------------------------------------------------------------------
  // Timers
  // ------------------------------------------------------------------

  advance(elapsed: number): void {
    for (let t = 0; t < 4; t++) {
      const cnt = this.tmCnt[t];
      if (!this.freeRunning(t)) continue;
      const shift = PRESCALER_SHIFT[cnt & 3];
      const acc = this.tmAcc[t] + elapsed;
      this.tmAcc[t] = acc & ((1 << shift) - 1);
      const ticks = acc >>> shift;
      if (ticks) this.addTicks(t, ticks);
    }
  }

  /** Enabled and clocked by the prescaler rather than by cascade. */
  private freeRunning(t: number): boolean {
    const cnt = this.tmCnt[t];
    return (cnt & TIMER_ENABLE) !== 0 && (t === 0 || !(cnt & TIMER_CASCADE));
  }

  /** Cycles until the next timer overflow (which may raise an IRQ, feed a
   *  sound FIFO or cascade). */
  cyclesUntilEvent(): number {
    let best = 0x7fffffff;
    for (let t = 0; t < 4; t++) {
      const cnt = this.tmCnt[t];
      if (!this.freeRunning(t)) continue;
      const shift = PRESCALER_SHIFT[cnt & 3];
      const until = ((0x10000 - this.tmCounter[t]) << shift) - this.tmAcc[t];
      if (until < best) best = until;
    }
    return best;
  }

  private addTicks(t: number, ticks: number): void {
    let c = this.tmCounter[t] + ticks;
    if (c < 0x10000) { this.tmCounter[t] = c; return; }
    const period = 0x10000 - this.tmReload[t];
    c -= 0x10000;
    const overflows = 1 + Math.floor(c / period);
    this.tmCounter[t] = this.tmReload[t] + (c % period);

    if (this.tmCnt[t] & TIMER_IRQ) this.requestIrq(IRQ_TIMER0 + t);
    if (t < 2) for (let i = 0; i < overflows; i++) this.apu.timerOverflow(t);
    if (t < 3 && (this.tmCnt[t + 1] & (TIMER_ENABLE | TIMER_CASCADE)) === (TIMER_ENABLE | TIMER_CASCADE)) {
      this.addTicks(t + 1, overflows);
    }
  }

  private writeTimerControl(t: number, value: number): void {
    const wasOn = (this.tmCnt[t] & TIMER_ENABLE) !== 0;
    this.tmCnt[t] = value & 0xc7;
    if (!wasOn && value & TIMER_ENABLE) {
      this.tmCounter[t] = this.tmReload[t];
      this.tmAcc[t] = 0;
    }
  }

  // ------------------------------------------------------------------
  // DMA
  // ------------------------------------------------------------------

  /** Run every enabled channel waiting on this trigger. For
   *  DmaTiming.Special, `fifo` selects sound FIFO A (0) or B (1). */
  dmaTrigger(timing: DmaTiming, fifo = -1): void {
    for (let ch = 0; ch < 4; ch++) {
      const cntH = this.dmaCntH[ch];
      if (!(cntH & DMA_ENABLE) || ((cntH >>> 12) & 3) !== timing) continue;
      if (timing === DmaTiming.Special) {
        // Channels 1/2 serve the sound FIFOs. Channel 3's special mode is
        // video capture and channel 0 has none; neither is supported.
        if (ch !== 1 + fifo) continue;
        this.runFifoDma(ch);
      } else {
        this.runDma(ch);
      }
    }
  }

  private runFifoDma(ch: number): void {
    // Always four 32-bit words to a fixed destination.
    const dst = this.dmaDst[ch];
    const srcStep = dmaStep((this.dmaCntH[ch] >>> 7) & 3, 4);
    let src = this.dmaSrc[ch];
    for (let i = 0; i < 4; i++) {
      this.bus.write32Seq(dst, this.bus.read32Seq(src));
      src = (src + srcStep) >>> 0;
    }
    this.dmaSrc[ch] = src;
    this.finishDma(ch);
  }

  private runDma(ch: number): void {
    const cntH = this.dmaCntH[ch];
    const wide = (cntH & 0x0400) !== 0;
    const unit = wide ? 4 : 2;
    const dstMode = (cntH >>> 5) & 3;
    const srcStep = dmaStep((cntH >>> 7) & 3, unit);
    const dstStep = dmaStep(dstMode, unit);
    const count = this.dmaCntL[ch] || (ch === 3 ? 0x10000 : 0x4000);
    const bus = this.bus;

    let src = this.dmaSrc[ch];
    let dst = this.dmaDst[ch];
    if (ch === 3 && dst >>> 24 === 0x0d) bus.save.eepromDmaHint(count);

    bus.internal(2);
    if (wide) {
      bus.write32(dst, bus.read32(src));
      for (let i = 1; i < count; i++) {
        src = (src + srcStep) >>> 0; dst = (dst + dstStep) >>> 0;
        bus.write32Seq(dst, bus.read32Seq(src));
      }
    } else {
      bus.write16(dst, bus.read16(src));
      for (let i = 1; i < count; i++) {
        src = (src + srcStep) >>> 0; dst = (dst + dstStep) >>> 0;
        bus.write16Seq(dst, bus.read16Seq(src));
      }
    }
    this.dmaSrc[ch] = (src + srcStep) >>> 0;
    // Destination mode 3 increments during the burst, then reloads.
    this.dmaDst[ch] = dstMode === 3 ? this.dmaDad[ch] : (dst + dstStep) >>> 0;
    this.finishDma(ch);
  }

  private finishDma(ch: number): void {
    const cntH = this.dmaCntH[ch];
    if (cntH & 0x4000) this.requestIrq(IRQ_DMA0 + ch);
    const immediate = ((cntH >>> 12) & 3) === DmaTiming.Immediate;
    if (immediate || !(cntH & 0x0200)) this.dmaCntH[ch] &= ~DMA_ENABLE;
    this.bus.breakSeq();
  }

  private writeDmaControl(ch: number, value: number): void {
    const wasOn = (this.dmaCntH[ch] & DMA_ENABLE) !== 0;
    this.dmaCntH[ch] = value & (ch === 3 ? 0xffe0 : 0xf7e0);
    if (wasOn || !(value & DMA_ENABLE)) return;
    this.dmaSrc[ch] = this.dmaSad[ch];
    this.dmaDst[ch] = this.dmaDad[ch];
    if (((value >>> 12) & 3) === DmaTiming.Immediate) this.runDma(ch);
  }

  // ------------------------------------------------------------------
  // IO dispatch (halfword registers, 0x0B0-0x3FF)
  // ------------------------------------------------------------------

  ioRead(off: number): number {
    if (off >= 0xb0 && off < 0xe0) {
      const ch = ((off - 0xb0) / 12) | 0;
      switch ((off - 0xb0) % 12) {
        case 8: return 0;
        case 10: return this.dmaCntH[ch];
        default: return -1; // SAD/DAD are write-only
      }
    }
    if (off >= 0x100 && off < 0x110) {
      const t = (off - 0x100) >> 2;
      return off & 2 ? this.tmCnt[t] : this.tmCounter[t];
    }
    switch (off) {
      case 0x120: case 0x122: return 0; // SIODATA32 / SIOMULTI0-1
      case 0x124: case 0x126: return 0;
      case 0x128: return this.siocnt;
      case 0x12a: return this.siodata;
      case 0x130: return this.keyinput;
      case 0x132: return this.keycnt;
      case 0x134: return this.rcnt;
      case 0x140: return this.joycnt;
      case 0x150: case 0x152: return this.joyRecv;
      case 0x154: case 0x156: return this.joySend;
      case 0x158: return 0;
      case 0x200: return this.ie;
      case 0x202: return this.if_;
      case 0x204: return this.waitcnt;
      case 0x208: return this.ime;
      case 0x300: return this.postflg;
    }
    return -1;
  }

  ioWrite(off: number, value: number): void {
    if (off >= 0xb0 && off < 0xe0) {
      const ch = ((off - 0xb0) / 12) | 0;
      switch ((off - 0xb0) % 12) {
        case 0: this.dmaSad[ch] = (this.dmaSad[ch] & 0xffff0000) | value; break;
        case 2: this.dmaSad[ch] = ((this.dmaSad[ch] & 0xffff) | (value << 16)) & DMA_SRC_MASK[ch]; break;
        case 4: this.dmaDad[ch] = (this.dmaDad[ch] & 0xffff0000) | value; break;
        case 6: this.dmaDad[ch] = ((this.dmaDad[ch] & 0xffff) | (value << 16)) & DMA_DST_MASK[ch]; break;
        case 8: this.dmaCntL[ch] = value & (ch === 3 ? 0xffff : 0x3fff); break;
        case 10: this.writeDmaControl(ch, value); break;
      }
      return;
    }
    if (off >= 0x100 && off < 0x110) {
      const t = (off - 0x100) >> 2;
      if (off & 2) this.writeTimerControl(t, value);
      else this.tmReload[t] = value;
      return;
    }
    switch (off) {
      case 0x128:
        // No link partner: a started transfer completes immediately.
        this.siocnt = value & ~0x80;
        if ((value & 0x4080) === 0x4080) this.requestIrq(7);
        return;
      case 0x12a: this.siodata = value; return;
      case 0x132: this.keycnt = value; this.checkKeypadIrq(); return;
      case 0x134: this.rcnt = value; return;
      case 0x140: this.joycnt = value; return;
      case 0x154: this.joySend = value; return;
      case 0x200: this.ie = value & 0x3fff; this.updateIrqLine(); return;
      case 0x202: this.if_ &= ~value; this.updateIrqLine(); return;
      case 0x204:
        this.waitcnt = value & 0x5fff;
        this.bus.setWaitControl(this.waitcnt);
        return;
      case 0x208: this.ime = value & 1; this.updateIrqLine(); return;
      case 0x300:
        this.ioWrite8(0x300, value & 0xff);
        this.ioWrite8(0x301, value >>> 8);
        return;
    }
  }

  /** Byte writes to the two halfwords whose bytes act independently. */
  ioWrite8(off: number, value: number): void {
    switch (off) {
      case 0x202: this.if_ &= ~value; this.updateIrqLine(); return;
      case 0x203: this.if_ &= ~(value << 8); this.updateIrqLine(); return;
      case 0x300: this.postflg |= value & 1; return;
      // HALTCNT: bit 7 selects STOP, which we treat as HALT.
      case 0x301: this.halt(); return;
    }
  }

  // ------------------------------------------------------------------
  // Save states
  // ------------------------------------------------------------------

  saveState(w: StateWriter): void {
    w.u16(this.ie); w.u16(this.if_); w.u8(this.ime);
    w.array(this.tmReload); w.array(this.tmCounter); w.array(this.tmCnt); w.array(this.tmAcc);
    w.array(this.dmaSad); w.array(this.dmaDad); w.array(this.dmaCntL); w.array(this.dmaCntH);
    w.array(this.dmaSrc); w.array(this.dmaDst);
    w.u16(this.keyinput); w.u16(this.keycnt);
    w.u16(this.siocnt); w.u16(this.siodata); w.u16(this.rcnt);
    w.u16(this.joycnt); w.u16(this.joyRecv); w.u16(this.joySend);
    w.u16(this.waitcnt); w.u8(this.postflg);
  }

  loadState(r: StateReader): void {
    this.ie = r.u16(); this.if_ = r.u16(); this.ime = r.u8();
    r.arrayInto(this.tmReload); r.arrayInto(this.tmCounter); r.arrayInto(this.tmCnt); r.arrayInto(this.tmAcc);
    r.arrayInto(this.dmaSad); r.arrayInto(this.dmaDad); r.arrayInto(this.dmaCntL); r.arrayInto(this.dmaCntH);
    r.arrayInto(this.dmaSrc); r.arrayInto(this.dmaDst);
    // Held buttons belong to the player, not the snapshot.
    r.u16(); this.keycnt = r.u16();
    this.siocnt = r.u16(); this.siodata = r.u16(); this.rcnt = r.u16();
    this.joycnt = r.u16(); this.joyRecv = r.u16(); this.joySend = r.u16();
    this.waitcnt = r.u16(); this.postflg = r.u8();
    this.bus.setWaitControl(this.waitcnt);
    this.updateIrqLine();
  }
}

function dmaStep(mode: number, unit: number): number {
  return mode === 1 ? -unit : mode === 2 ? 0 : unit;
}
