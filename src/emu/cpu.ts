// ARM7TDMI CPU core.
// Interpreter with table-driven decode for both ARM and Thumb states.
// Pipeline model: `pc` is the architectural r15 during execution, i.e.
// pc = execAddr + 8 (ARM) or +4 (Thumb). The pipeline holds the two
// instructions ahead of the one executing.

import type { Bus } from "./bus";
import type { StateReader, StateWriter } from "./state";

export const MODE_USR = 0x10;
export const MODE_FIQ = 0x11;
export const MODE_IRQ = 0x12;
export const MODE_SVC = 0x13;
export const MODE_ABT = 0x17;
export const MODE_UND = 0x1b;
export const MODE_SYS = 0x1f;

const N = 0x80000000;
const Z = 0x40000000;
const C = 0x20000000;
const V = 0x10000000;
const I = 0x80;
const F = 0x40;
const T = 0x20;

type Handler = (instr: number) => void;

const BANKED_MODES = [MODE_USR, MODE_FIQ, MODE_IRQ, MODE_SVC, MODE_ABT, MODE_UND];

// Condition codes as a truth table over the NZCV nibble: bit f of
// COND_TABLE[cond] is set when `cond` passes with flags f.
const COND_TABLE = new Uint16Array(16);
for (let flags = 0; flags < 16; flags++) {
  const n = (flags & 8) !== 0, z = (flags & 4) !== 0, c = (flags & 2) !== 0, v = (flags & 1) !== 0;
  const pass = [
    z, !z, c, !c, n, !n, v, !v,
    c && !z, !c || z, n === v, n !== v, !z && n === v, z || n !== v, true, false,
  ];
  pass.forEach((p, cond) => { if (p) COND_TABLE[cond] |= 1 << flags; });
}

export class CPU {
  bus!: Bus;

  /** HLE SWI dispatch; only used when no BIOS image is loaded. */
  swiHandler: (num: number) => void = () => {};
  /** Level of the interrupt controller's output (IME && IE & IF). */
  irqLine = false;
  biosPresent = false;
  /** Set by HALTCNT / Halt SWIs; cleared by the interrupt controller. */
  halted = false;

  r = new Int32Array(16);
  cpsr = MODE_SYS | I | F;
  pc = 0;

  private thumb = false;
  private pipe0 = 0;
  private pipe1 = 0;
  private flushed = false;
  /** Carry out of the most recent barrel-shifter operation. */
  private shiftCarry = false;

  // Banked storage for modes that are not currently active.
  private fiqLo = new Int32Array(5);
  private otherLo = new Int32Array(5);
  private bankHi: Record<number, Int32Array> = {
    [MODE_USR]: new Int32Array(2),
    [MODE_FIQ]: new Int32Array(2),
    [MODE_SVC]: new Int32Array(2),
    [MODE_ABT]: new Int32Array(2),
    [MODE_IRQ]: new Int32Array(2),
    [MODE_UND]: new Int32Array(2),
  };
  private spsrBank: Record<number, number> = {
    [MODE_FIQ]: 0, [MODE_SVC]: 0, [MODE_ABT]: 0, [MODE_IRQ]: 0, [MODE_UND]: 0,
  };

  private armTable: Handler[] = [];
  private thumbTable: Handler[] = [];

  constructor() {
    this.bankHi[MODE_SYS] = this.bankHi[MODE_USR]; // System mode uses the User bank
    this.buildArmTable();
    this.buildThumbTable();
  }

  // ------------------------------------------------------------------
  // Flags
  // ------------------------------------------------------------------

  get n(): boolean { return this.cpsr < 0; } // bit31 sign on Int32
  get z(): boolean { return (this.cpsr & Z) !== 0; }
  get c(): boolean { return (this.cpsr & C) !== 0; }
  get v(): boolean { return (this.cpsr & V) !== 0; }
  get mode(): number { return this.cpsr & 0x1f; }
  get isThumb(): boolean { return this.thumb; }

  setNZ(result: number): void {
    this.cpsr = (this.cpsr & ~(N | Z)) | (result < 0 ? N : 0) | ((result | 0) === 0 ? Z : 0);
  }

  private setC(b: boolean): void {
    this.cpsr = b ? this.cpsr | C : this.cpsr & ~C;
  }
  private setV(b: boolean): void {
    this.cpsr = b ? this.cpsr | V : this.cpsr & ~V;
  }

  private addFlags(a: number, b: number, res: number): void {
    this.setNZ(res);
    this.setC((a >>> 0) + (b >>> 0) > 0xffffffff);
    this.setV((~(a ^ b) & (a ^ res)) < 0);
  }

  private addCarryFlags(a: number, b: number, c: number, res: number): void {
    this.setNZ(res);
    this.setC((a >>> 0) + (b >>> 0) + c > 0xffffffff);
    this.setV((~(a ^ b) & (a ^ res)) < 0);
  }

  private subFlags(a: number, b: number, res: number): void {
    this.setNZ(res);
    this.setC((a >>> 0) >= b >>> 0);
    this.setV(((a ^ b) & (a ^ res)) < 0);
  }

  private subBorrowFlags(a: number, b: number, borrow: number, res: number): void {
    this.setNZ(res);
    this.setC((a >>> 0) >= (b >>> 0) + borrow); // doubles: no wraparound
    this.setV(((a ^ b) & (a ^ res)) < 0);
  }

  // ------------------------------------------------------------------
  // Banking
  // ------------------------------------------------------------------

  private switchMode(newMode: number): void {
    const old = this.mode;
    if (old === newMode) return;
    const loSave = old === MODE_FIQ ? this.fiqLo : this.otherLo;
    for (let i = 0; i < 5; i++) loSave[i] = this.r[8 + i];
    const hi = this.bankHi[old];
    hi[0] = this.r[13];
    hi[1] = this.r[14];
    const loLoad = newMode === MODE_FIQ ? this.fiqLo : this.otherLo;
    for (let i = 0; i < 5; i++) this.r[8 + i] = loLoad[i];
    const hi2 = this.bankHi[newMode];
    this.r[13] = hi2[0];
    this.r[14] = hi2[1];
    this.cpsr = (this.cpsr & ~0x1f) | newMode;
  }

  private setCPSR(value: number): void {
    const prevMode = this.mode;
    const privileged = prevMode !== MODE_USR;
    const newMode = privileged ? value & 0x1f : prevMode;
    const thumb = privileged ? (value & T) !== 0 : this.thumb;
    this.switchMode(newMode);
    const mask = privileged ? 0xf00000ff : 0xf0000000;
    this.cpsr = (this.cpsr & ~mask) | (value & mask);
    this.thumb = thumb;
    if (thumb) this.cpsr |= T; else this.cpsr &= ~T;
  }

  writeCPSR(value: number, mask: number): void {
    let v = this.cpsr;
    if (mask & 0x8) v = (v & 0x0fffffff) | (value & 0xf0000000);
    if (mask & 0x2) v = (v & 0xffff00ff) | (value & 0x0000ff00);
    if (mask & 0x4) v = (v & 0xff00ffff) | (value & 0x00ff0000);
    if (mask & 0x1) v = (v & 0xffffff00) | (value & 0x000000ff);
    this.setCPSR(v);
  }

  getSPSR(): number {
    const m = this.mode;
    if (m === MODE_USR || m === MODE_SYS) return this.cpsr;
    return this.spsrBank[m] ?? 0;
  }

  setSPSR(value: number, mask = 0xf): void {
    const m = this.mode;
    if (m === MODE_USR || m === MODE_SYS) return;
    let v = this.spsrBank[m] ?? 0;
    if (mask & 0x8) v = (v & 0x0fffffff) | (value & 0xf0000000);
    if (mask & 0x2) v = (v & 0xffff00ff) | (value & 0x0000ff00);
    if (mask & 0x4) v = (v & 0xff00ffff) | (value & 0x00ff0000);
    if (mask & 0x1) v = (v & 0xffffff00) | (value & 0x000000ff);
    this.spsrBank[m] = v;
  }

  private userReg(i: number): number {
    if (i < 8) return this.r[i];
    if (this.mode === MODE_USR || this.mode === MODE_SYS) return this.r[i];
    if (i < 13) return this.otherLo[i - 8];
    return this.bankHi[MODE_USR][i - 13];
  }

  private setUserReg(i: number, v: number): void {
    if (i < 8 || this.mode === MODE_USR || this.mode === MODE_SYS) { this.r[i] = v | 0; return; }
    if (i < 13) { this.otherLo[i - 8] = v | 0; return; }
    this.bankHi[MODE_USR][i - 13] = v | 0;
  }

  // ------------------------------------------------------------------
  // Pipeline
  // ------------------------------------------------------------------

  flush(): void {
    this.bus.breakSeq();
    if (this.thumb) {
      this.pc &= ~1;
      this.pipe0 = this.bus.fetch16(this.pc); this.pc += 2;
      this.pipe1 = this.bus.fetch16(this.pc); this.pc += 2;
    } else {
      this.pc &= ~3;
      this.pipe0 = this.bus.fetch32(this.pc); this.pc += 4;
      this.pipe1 = this.bus.fetch32(this.pc); this.pc += 4;
    }
    this.pc >>>= 0;
    this.flushed = true;
  }

  private writePC(value: number): void {
    this.pc = value | 0;
    this.flush();
  }

  /** State the BIOS hands over to a cartridge: System mode, interrupts on,
   *  per-mode stacks at the top of IWRAM. */
  bootState(entry: number): void {
    this.r.fill(0);
    this.fiqLo.fill(0); this.otherLo.fill(0);
    for (const m of BANKED_MODES) { this.bankHi[m].fill(0); this.spsrBank[m] = 0; }
    this.bankHi[MODE_IRQ][0] = 0x03007fa0;
    this.bankHi[MODE_SVC][0] = 0x03007fe0;
    this.cpsr = MODE_SYS;
    this.thumb = false;
    this.halted = false;
    this.r[13] = 0x03007f00;
    this.writePC(entry);
  }

  /** Execute one instruction. The caller skips this while `halted`. */
  step(): void {
    if (this.irqLine && !(this.cpsr & I)) {
      this.exception(0x18, MODE_IRQ);
    }
    this.flushed = false;
    if (this.thumb) {
      const instr = this.pipe0;
      this.pipe0 = this.pipe1;
      this.pipe1 = this.bus.fetch16(this.pc);
      this.thumbTable[instr >>> 6](instr);
      if (!this.flushed) this.pc = (this.pc + 2) | 0;
    } else {
      const instr = this.pipe0;
      this.pipe0 = this.pipe1;
      this.pipe1 = this.bus.fetch32(this.pc);
      if ((COND_TABLE[instr >>> 28] >>> (this.cpsr >>> 28)) & 1) {
        this.armTable[((instr >>> 16) & 0xff0) | ((instr >>> 4) & 0xf)].call(this, instr);
      }
      if (!this.flushed) this.pc = (this.pc + 4) | 0;
    }
  }

  /** Re-run the instruction currently executing once it is next reached;
   *  used by HLE SWIs that block (IntrWait). */
  restartInstruction(): void {
    this.writePC((this.pc - (this.thumb ? 4 : 8)) | 0);
  }

  /** Enter an exception. `lr` defaults to the IRQ convention: the address
   *  of the next instruction + 4, where at an instruction boundary
   *  pc = nextExec + 8 (ARM) or + 4 (Thumb). */
  saveState(w: StateWriter): void {
    w.array(this.r);
    w.u32(this.cpsr); w.u32(this.pc); w.bool(this.halted);
    w.array(this.fiqLo); w.array(this.otherLo);
    for (const m of BANKED_MODES) {
      w.array(this.bankHi[m]);
      w.u32(this.spsrBank[m] ?? 0);
    }
  }

  loadState(r: StateReader): void {
    r.arrayInto(this.r);
    this.cpsr = r.u32() | 0;
    const pc = r.u32();
    this.halted = r.bool();
    r.arrayInto(this.fiqLo); r.arrayInto(this.otherLo);
    for (const m of BANKED_MODES) {
      r.arrayInto(this.bankHi[m]);
      const spsr = r.u32();
      if (m !== MODE_USR) this.spsrBank[m] = spsr;
    }
    // `pc` was saved two instructions ahead; refill the pipeline behind it.
    this.thumb = (this.cpsr & T) !== 0;
    this.pc = (pc - (this.thumb ? 4 : 8)) | 0;
    const cycles = this.bus.cycles;
    this.flush();
    this.bus.cycles = cycles;
  }

  private exception(vector: number, mode: number, lr = this.thumb ? this.pc : (this.pc - 4) | 0): void {
    const saved = this.cpsr;
    this.switchMode(mode);
    this.spsrBank[mode] = saved;
    this.r[14] = lr;
    this.thumb = false;
    this.cpsr = (this.cpsr & ~(T | 0x1f)) | mode | I;
    this.pc = vector;
    this.flush();
    this.bus.internal(1);
  }

  private swi(num: number): void {
    if (this.biosPresent) {
      // Vector into the real BIOS; LR is the instruction after the SWI.
      this.exception(0x08, MODE_SVC, (this.pc - (this.thumb ? 2 : 4)) | 0);
    } else {
      // HLE: perform the SWI inline and continue at the next instruction.
      this.swiHandler(num);
    }
  }

  // ------------------------------------------------------------------
  // Shared shifter
  // ------------------------------------------------------------------

  /** Rotated 8-bit immediate operand; carry-out lands in `shiftCarry`. */
  private shifterImm(instr: number): number {
    const imm = instr & 0xff;
    const rot = ((instr >>> 8) & 0xf) * 2;
    if (rot === 0) { this.shiftCarry = this.c; return imm; }
    const v = ((imm >>> rot) | (imm << (32 - rot))) | 0;
    this.shiftCarry = v < 0;
    return v;
  }

  /** Barrel shifter for a register operand; carry-out lands in `shiftCarry`. */
  private shiftValue(rm: number, type: number, amount: number, byReg: boolean): number {
    let sc = this.c;
    let op2 = rm;
    switch (type) {
      case 0: // LSL
        if (amount === 0) break;
        if (amount < 32) { sc = (rm & (1 << (32 - amount))) !== 0; op2 = (rm << amount) | 0; }
        else if (amount === 32) { sc = (rm & 1) !== 0; op2 = 0; }
        else { sc = false; op2 = 0; }
        break;
      case 1: // LSR
        if (amount === 0 && !byReg) amount = 32;
        if (amount === 0) break;
        if (amount < 32) { sc = (rm & (1 << (amount - 1))) !== 0; op2 = (rm >>> amount) | 0; }
        else if (amount === 32) { sc = rm < 0; op2 = 0; }
        else { sc = false; op2 = 0; }
        break;
      case 2: // ASR
        if (amount === 0 && !byReg) amount = 32;
        if (amount === 0) break;
        if (amount >= 32) { sc = rm < 0; op2 = rm < 0 ? -1 : 0; }
        else { sc = (rm & (1 << (amount - 1))) !== 0; op2 = (rm >> amount) | 0; }
        break;
      case 3: // ROR / RRX
        if (!byReg && amount === 0) {
          const oc = this.c;
          op2 = ((oc ? 0x80000000 : 0) | (rm >>> 1)) | 0;
          sc = (rm & 1) !== 0;
        } else {
          amount &= 31;
          if (amount === 0) sc = rm < 0;
          else { sc = (rm & (1 << (amount - 1))) !== 0; op2 = ((rm >>> amount) | (rm << (32 - amount))) | 0; }
        }
        break;
    }
    this.shiftCarry = sc;
    return op2 | 0;
  }

  /** LDR of a misaligned address reads the aligned word, rotated. */
  private loadWord(addr: number): number {
    const raw = this.bus.read32(addr);
    const rot = (addr & 3) * 8;
    return rot ? (raw >>> rot) | (raw << (32 - rot)) : raw | 0;
  }

  private regRead(i: number): number {
    return i === 15 ? this.pc | 0 : this.r[i] | 0;
  }

  // ------------------------------------------------------------------
  // ARM handlers
  // ------------------------------------------------------------------

  private condPass(cond: number): boolean {
    return ((COND_TABLE[cond] >>> (this.cpsr >>> 28)) & 1) !== 0;
  }

  private armDataProc(instr: number): void {
    const opcode = (instr >>> 21) & 0xf;
    const setF = (instr & 0x00100000) !== 0;
    const rn = (instr >>> 16) & 0xf;
    const rd = (instr >>> 12) & 0xf;
    // With a register-specified shift the operand evaluation takes an extra
    // cycle, so r15 reads as pc+12 (vs pc+8) for both rn and rm.
    const byReg = (instr & 0x02000000) === 0 && (instr & 0x10) !== 0;
    const pcExtra = byReg ? 4 : 0;
    const a = rn === 15 ? (this.pc + pcExtra) | 0 : this.r[rn] | 0;

    let op2: number;
    if (instr & 0x02000000) {
      op2 = this.shifterImm(instr);
    } else {
      const rm = (instr & 0xf) === 15 ? (this.pc + pcExtra) | 0 : this.r[instr & 0xf] | 0;
      const amount = byReg
        ? this.regRead((instr >>> 8) & 0xf) & 0xff
        : (instr >>> 7) & 0x1f;
      if (byReg) this.bus.internal(1);
      if (byReg && amount === 0) { op2 = rm; this.shiftCarry = this.c; }
      else op2 = this.shiftValue(rm, (instr >>> 5) & 3, amount, byReg);
    }
    const sc = this.shiftCarry;

    let res: number;
    switch (opcode) {
      case 0x0: res = a & op2; if (setF) { this.setNZ(res); this.setC(sc); } this.writeRd(rd, res, setF); return;
      case 0x1: res = a ^ op2; if (setF) { this.setNZ(res); this.setC(sc); } this.writeRd(rd, res, setF); return;
      case 0x2: res = (a - op2) | 0; if (setF) this.subFlags(a, op2, res); this.writeRd(rd, res, setF); return;
      case 0x3: res = (op2 - a) | 0; if (setF) this.subFlags(op2, a, res); this.writeRd(rd, res, setF); return;
      case 0x4: res = (a + op2) | 0; if (setF) this.addFlags(a, op2, res); this.writeRd(rd, res, setF); return;
      case 0x5: { const c = this.c ? 1 : 0; res = (a + op2 + c) | 0; if (setF) this.addCarryFlags(a, op2, c, res); this.writeRd(rd, res, setF); return; }
      case 0x6: { const bc = this.c ? 0 : 1; res = (a - op2 - bc) | 0; if (setF) this.subBorrowFlags(a, op2, bc, res); this.writeRd(rd, res, setF); return; }
      case 0x7: { const bc = this.c ? 0 : 1; res = (op2 - a - bc) | 0; if (setF) this.subBorrowFlags(op2, a, bc, res); this.writeRd(rd, res, setF); return; }
      case 0x8: res = a & op2; this.setNZ(res); this.setC(sc); this.tstP(rd, setF); return;
      case 0x9: res = a ^ op2; this.setNZ(res); this.setC(sc); this.tstP(rd, setF); return;
      case 0xa: res = (a - op2) | 0; this.subFlags(a, op2, res); this.tstP(rd, setF); return;
      case 0xb: res = (a + op2) | 0; this.addFlags(a, op2, res); this.tstP(rd, setF); return;
      case 0xc: res = a | op2; if (setF) { this.setNZ(res); this.setC(sc); } this.writeRd(rd, res, setF); return;
      case 0xd: res = op2; if (setF) { this.setNZ(res); this.setC(sc); } this.writeRd(rd, res, setF); return;
      case 0xe: res = a & ~op2; if (setF) { this.setNZ(res); this.setC(sc); } this.writeRd(rd, res, setF); return;
      case 0xf: res = ~op2; if (setF) { this.setNZ(res); this.setC(sc); } this.writeRd(rd, res, setF); return;
    }
  }

  /** TST/TEQ/CMP/CMN with rd=15 restore SPSR into CPSR (ARMv4 "P" variants). */
  private tstP(rd: number, setF: boolean): void {
    if (setF && rd === 15 && this.mode !== MODE_USR && this.mode !== MODE_SYS) {
      const spsr = this.getSPSR();
      const keep = this.cpsr & 0xf0000000;
      this.setCPSR((spsr & 0x0fffffff) | keep);
    }
  }

  private writeRd(rd: number, value: number, setF: boolean): void {
    if (rd === 15) {
      if (setF && this.mode !== MODE_USR && this.mode !== MODE_SYS) {
        this.setCPSR(this.getSPSR());
      }
      this.writePC(value);
      return;
    }
    this.r[rd] = value | 0;
  }

  private armBranch(instr: number): void {
    if (instr & 0x01000000) this.r[14] = (this.pc - 4) | 0;
    const off = ((instr & 0x00ffffff) << 8) >> 8;
    this.writePC((this.pc + (off << 2)) | 0);
  }

  private armSWI(instr: number): void {
    this.swi((instr >>> 16) & 0xff);
  }

  private mulCycles(rs: number): number {
    const u = rs >>> 0;
    if (u <= 0xff || u >= 0xffffff00) return 1;
    if (u <= 0xffff || u >= 0xffff0000) return 2;
    if (u <= 0xffffff || u >= 0xff000000) return 3;
    return 4;
  }

  private armMul(instr: number): void {
    const acc = (instr & 0x00200000) !== 0;
    const setF = (instr & 0x00100000) !== 0;
    const rd = (instr >>> 16) & 0xf;
    const rs = (instr >>> 8) & 0xf;
    const rm = instr & 0xf;
    let res = Math.imul(this.r[rm], this.r[rs]) | 0;
    if (acc) res = (res + this.r[(instr >>> 12) & 0xf]) | 0;
    this.r[rd] = res;
    if (setF) this.setNZ(res);
    this.bus.internal(this.mulCycles(this.r[rs]) + (acc ? 1 : 0));
  }

  private armMulLong(instr: number): void {
    const signed = (instr & 0x00400000) !== 0;
    const acc = (instr & 0x00200000) !== 0;
    const setF = (instr & 0x00100000) !== 0;
    const rdHi = (instr >>> 16) & 0xf;
    const rdLo = (instr >>> 12) & 0xf;
    const rs = (instr >>> 8) & 0xf;
    const a = this.r[instr & 0xf] | 0;
    const b = this.r[rs] | 0;
    // 32x32 -> 64 via 16-bit limbs; signedness is a correction to the
    // high word.
    const aL = a & 0xffff, aH = a >>> 16, bL = b & 0xffff, bH = b >>> 16;
    const mid = aH * bL + ((aL * bL) >>> 16);
    const mid2 = aL * bH + (mid & 0xffff);
    let lo = Math.imul(a, b);
    let hi = (aH * bH + Math.floor(mid / 0x10000) + Math.floor(mid2 / 0x10000)) | 0;
    if (signed) {
      if (a < 0) hi = (hi - b) | 0;
      if (b < 0) hi = (hi - a) | 0;
    }
    if (acc) {
      const sum = (lo >>> 0) + (this.r[rdLo] >>> 0);
      lo = sum | 0;
      hi = (hi + this.r[rdHi] + (sum > 0xffffffff ? 1 : 0)) | 0;
    }
    this.r[rdLo] = lo;
    this.r[rdHi] = hi;
    if (setF) {
      this.cpsr = (this.cpsr & ~(N | Z)) | (hi < 0 ? N : 0) | (hi === 0 && lo === 0 ? Z : 0);
    }
    this.bus.internal(this.mulCycles(b) + (acc ? 2 : 1));
  }

  private armHalfTransfer(instr: number): void {
    const pre = (instr & 0x01000000) !== 0;
    const up = (instr & 0x00800000) !== 0;
    const imm = (instr & 0x00400000) !== 0;
    const wb = (instr & 0x00200000) !== 0;
    const load = (instr & 0x00100000) !== 0;
    const rn = (instr >>> 16) & 0xf;
    const rd = (instr >>> 12) & 0xf;
    const sh = (instr >>> 5) & 3;
    const offset = imm
      ? (((instr >>> 8) & 0xf) << 4) | (instr & 0xf)
      : this.r[instr & 0xf] | 0;

    const base = this.regRead(rn) >>> 0;
    const offAddr = (base + (up ? offset : -offset)) >>> 0;
    const addr = pre ? offAddr : base;

    if (load) {
      let v = 0;
      if (sh === 1) {
        // A misaligned LDRH reads the aligned halfword rotated by 8.
        v = this.bus.read16(addr);
        if (addr & 1) v = ((v >>> 8) | (v << 24)) >>> 0;
      } else if (sh === 2 || addr & 1) {
        // ...and a misaligned LDRSH degrades to LDRSB.
        v = (this.bus.read8(addr) << 24) >> 24;
      } else {
        v = (this.bus.read16(addr) << 16) >> 16;
      }
      if (rd === 15) this.writePC(v >>> 0);
      else this.r[rd] = v | 0;
      this.bus.internal(1);
      if ((wb || !pre) && rn !== rd) this.r[rn] = offAddr | 0;
    } else {
      if (sh === 1) {
        const data = rd === 15 ? (this.pc + 4) | 0 : this.r[rd] | 0;
        this.bus.write16(addr, data & 0xffff);
      }
      // sh 2/3 with L=0 are LDRD/STRD-space (ARMv5); ignore on v4.
      if (wb || !pre) this.r[rn] = offAddr | 0;
    }
  }

  private armSingleTransfer(instr: number): void {
    const regOff = (instr & 0x02000000) !== 0;
    const pre = (instr & 0x01000000) !== 0;
    const up = (instr & 0x00800000) !== 0;
    const byte = (instr & 0x00400000) !== 0;
    const wb = (instr & 0x00200000) !== 0;
    const load = (instr & 0x00100000) !== 0;
    const rn = (instr >>> 16) & 0xf;
    const rd = (instr >>> 12) & 0xf;

    let offset: number;
    if (regOff) {
      const rm = this.regRead(instr & 0xf);
      const amount = (instr >>> 7) & 0x1f;
      offset = this.shiftValue(rm, (instr >>> 5) & 3, amount, false) >>> 0;
    } else {
      offset = instr & 0xfff;
    }

    const base = this.regRead(rn) >>> 0;
    const offAddr = (base + (up ? offset : -offset)) >>> 0;
    const addr = pre ? offAddr : base;

    if (load) {
      let v: number;
      if (byte) {
        v = this.bus.read8(addr);
      } else {
        v = this.loadWord(addr);
      }
      if (rd === 15) this.writePC(v >>> 0);
      else this.r[rd] = v | 0;
      this.bus.internal(1);
      if ((wb || !pre) && rn !== rd) this.r[rn] = offAddr | 0;
    } else {
      const data = rd === 15 ? (this.pc + 4) | 0 : this.r[rd] | 0;
      if (byte) this.bus.write8(addr, data & 0xff);
      else this.bus.write32(addr, data >>> 0);
      if (wb || !pre) this.r[rn] = offAddr | 0;
    }
  }

  private armBlockTransfer(instr: number): void {
    const pre = (instr & 0x01000000) !== 0;
    const up = (instr & 0x00800000) !== 0;
    const s = (instr & 0x00400000) !== 0;
    const wb = (instr & 0x00200000) !== 0;
    const load = (instr & 0x00100000) !== 0;
    const rn = (instr >>> 16) & 0xf;
    let list = instr & 0xffff;
    // An empty list transfers r15 alone but moves the base by 0x40.
    let size = count8(list & 0xff) * 4 + count8(list >>> 8) * 4;
    if (list === 0) { list = 0x8000; size = 0x40; }

    const base = this.regRead(rn) >>> 0;
    const newBase = up ? (base + size) >>> 0 : (base - size) >>> 0;
    let addr = up
      ? (pre ? (base + 4) >>> 0 : base)
      : (pre ? (base - size) >>> 0 : (base - size + 4) >>> 0);

    const useUser = s && !(load && (list & 0x8000) !== 0);

    if (load) {
      let branchTo: number | null = null;
      let loadedIntoBase: number | null = null;
      for (let i = 0; i < 16; i++) {
        if (!(list & (1 << i))) continue;
        const v = this.bus.read32(addr) | 0;
        addr = (addr + 4) >>> 0;
        if (i === 15) branchTo = v >>> 0;
        else if (useUser) this.setUserReg(i, v);
        else this.r[i] = v;
        if (i === rn) loadedIntoBase = v;
      }
      if (wb) this.r[rn] = newBase | 0;
      if (loadedIntoBase !== null) this.r[rn] = loadedIntoBase;
      this.bus.internal(1);
      if (branchTo !== null) {
        if (s && this.mode !== MODE_USR && this.mode !== MODE_SYS) {
          this.setCPSR(this.getSPSR());
        }
        this.writePC(branchTo);
      }
    } else {
      let first = true;
      for (let i = 0; i < 16; i++) {
        if (!(list & (1 << i))) continue;
        let v: number;
        if (i === rn) v = first ? base | 0 : newBase | 0;
        else if (i === 15 && !useUser) v = (this.pc + 4) | 0;
        else v = useUser ? this.userReg(i) : this.r[i] | 0;
        this.bus.write32(addr, v >>> 0);
        addr = (addr + 4) >>> 0;
        first = false;
      }
      if (wb) this.r[rn] = newBase | 0;
    }
  }

  private armSwap(instr: number): void {
    const byte = (instr & 0x00400000) !== 0;
    const rn = (instr >>> 16) & 0xf;
    const rd = (instr >>> 12) & 0xf;
    const rm = instr & 0xf;
    const addr = this.regRead(rn) >>> 0;
    const src = this.r[rm] | 0;
    if (byte) {
      const v = this.bus.read8(addr);
      this.bus.write8(addr, src & 0xff);
      this.r[rd] = v;
    } else {
      const v = this.loadWord(addr);
      this.bus.write32(addr, src >>> 0);
      this.r[rd] = v;
    }
    this.bus.internal(1);
  }

  private armMRS(instr: number): void {
    const rd = (instr >>> 12) & 0xf;
    this.r[rd] = ((instr & 0x00400000) ? this.getSPSR() : this.cpsr) | 0;
  }

  private armMSR(instr: number): void {
    const toSPSR = (instr & 0x00400000) !== 0;
    const mask = (instr >>> 16) & 0xf;
    let value: number;
    if (instr & 0x02000000) value = this.shifterImm(instr);
    else value = this.r[instr & 0xf] | 0;
    if (toSPSR) this.setSPSR(value, mask);
    else this.writeCPSR(value, mask);
  }

  private armUndefined(_instr: number): void {
    this.exception(0x04, MODE_UND, (this.pc - (this.thumb ? 2 : 4)) | 0);
  }

  private armBX(instr: number): void {
    if (((instr >>> 8) & 0xfff) !== 0xfff) return; // not actually BX
    const target = this.r[instr & 0xf] | 0;
    this.thumb = (target & 1) !== 0;
    if (this.thumb) this.cpsr |= T; else this.cpsr &= ~T;
    this.writePC(target);
  }

  // ------------------------------------------------------------------
  // ARM decode
  // ------------------------------------------------------------------

  private buildArmTable(): void {
    for (let i = 0; i < 4096; i++) this.armTable[i] = this.decodeArmIndex(i);
  }

  private decodeArmIndex(i: number): Handler {
    const op = i >> 4;      // instr[27:20]
    const low = i & 0xf;    // instr[7:4]
    const b2725 = op >> 5;  // instr[27:25]

    // Handlers are invoked with .call(this); the condition check lives in step().
    const run = (fn: Handler): Handler => fn;
    const undef: Handler = this.armUndefined;

    if (b2725 === 0b101) return run(this.armBranch);
    if (b2725 === 0b100) return run(this.armBlockTransfer);
    if (b2725 === 0b110) return undef; // coprocessor transfers: none fitted
    if (b2725 === 0b111) {
      if (op & 0x10) return run(this.armSWI);
      return undef;
    }
    if (b2725 === 0b010 || b2725 === 0b011) {
      if (b2725 === 0b011 && (low & 1) !== 0) return undef;
      return run(this.armSingleTransfer);
    }

    // 000 / 001: data processing and friends
    if (b2725 === 0b000) {
      if (low === 0b1001) {
        if (op >> 2 === 0) return run(this.armMul);          // 000000 AS
        if (op >> 3 === 1) return run(this.armMulLong);      // 00001 UAS
        if (op >> 3 === 2) return run(this.armSwap);         // 00010 B00 SWP
        return run(this.armDataProc);                        // undefined space
      }
      if (low === 0b1011 || low === 0b1101 || low === 0b1111) {
        return run(this.armHalfTransfer);
      }
      if (low === 0b0001 && (op & 0xfb) === 0x12) return run(this.armBX);
      if ((op & 0xfb) === 0x10) return run(this.armMRS);     // 0x10/0x14
      if ((op & 0xfb) === 0x12) return run(this.armMSR);     // 0x12/0x16 reg
      return run(this.armDataProc);
    }
    // b2725 == 001
    if ((op & 0xfb) === 0x32) return run(this.armMSR);       // 0x32/0x36 imm
    return run(this.armDataProc);
  }

  // ------------------------------------------------------------------
  // Thumb handlers / decode
  // ------------------------------------------------------------------

  private thumbALU(op: number, rd: number, rs: number): void {
    const a = this.r[rd] | 0;
    const b = this.r[rs] | 0;
    let res: number;
    switch (op) {
      case 0x0: res = a & b; this.setNZ(res); this.r[rd] = res; return;
      case 0x1: res = a ^ b; this.setNZ(res); this.r[rd] = res; return;
      case 0x2: { // LSL
        const s = b & 0xff;
        if (s === 0) { this.setNZ(a); return; }
        if (s < 32) { this.setC((a & (1 << (32 - s))) !== 0); res = (a << s) | 0; }
        else if (s === 32) { this.setC((a & 1) !== 0); res = 0; }
        else { this.setC(false); res = 0; }
        this.setNZ(res); this.r[rd] = res; this.bus.internal(1); return;
      }
      case 0x3: { // LSR
        const s = b & 0xff;
        if (s === 0) { this.setNZ(a); return; }
        if (s < 32) { this.setC((a & (1 << (s - 1))) !== 0); res = (a >>> s) | 0; }
        else if (s === 32) { this.setC(a < 0); res = 0; }
        else { this.setC(false); res = 0; }
        this.setNZ(res); this.r[rd] = res; this.bus.internal(1); return;
      }
      case 0x4: { // ASR
        const s = b & 0xff;
        if (s === 0) { this.setNZ(a); return; }
        if (s >= 32) { this.setC(a < 0); res = a < 0 ? -1 : 0; }
        else { this.setC((a & (1 << (s - 1))) !== 0); res = (a >> s) | 0; }
        this.setNZ(res); this.r[rd] = res; this.bus.internal(1); return;
      }
      case 0x5: {
        const c = this.c ? 1 : 0;
        res = (a + b + c) | 0;
        this.addCarryFlags(a, b, c, res);
        this.r[rd] = res; return;
      }
      case 0x6: {
        const bc = this.c ? 0 : 1;
        res = (a - b - bc) | 0;
        this.subBorrowFlags(a, b, bc, res);
        this.r[rd] = res; return;
      }
      case 0x7: { // ROR
        const s = b & 0xff;
        if (s === 0) { this.setNZ(a); return; }
        const rot = s & 0x1f;
        if (rot === 0) { res = a; this.setC(a < 0); }
        else {
          res = ((a >>> rot) | (a << (32 - rot))) | 0;
          this.setC((a & (1 << (rot - 1))) !== 0);
        }
        this.setNZ(res); this.r[rd] = res; this.bus.internal(1); return;
      }
      case 0x8: res = a & b; this.setNZ(res); return;                    // TST
      case 0x9: res = (-b) | 0; this.subFlags(0, b, res); this.r[rd] = res; return; // NEG
      case 0xa: res = (a - b) | 0; this.subFlags(a, b, res); return;     // CMP
      case 0xb: res = (a + b) | 0; this.addFlags(a, b, res); return;     // CMN
      case 0xc: res = a | b; this.setNZ(res); this.r[rd] = res; return;  // ORR
      case 0xd: res = Math.imul(a, b) | 0; this.setNZ(res); this.r[rd] = res;
        this.bus.internal(this.mulCycles(b)); return;                  // MUL
      case 0xe: res = a & ~b; this.setNZ(res); this.r[rd] = res; return; // BIC
      case 0xf: res = ~b; this.setNZ(res); this.r[rd] = res; return;     // MVN
    }
  }

  private buildThumbTable(): void {
    for (let i = 0; i < 1024; i++) this.thumbTable[i] = this.decodeThumbIndex(i);
  }

  private decodeThumbIndex(i: number): Handler {
    const instr = i << 6;
    const nibble = instr >>> 12;

    switch (nibble) {
      case 0x0:
      case 0x1: {
        const op = (instr >>> 11) & 3;
        if (op === 3) {
          // ADD/SUB rd, rs, rn|#imm
          return (x) => {
            const imm = (x >>> 10) & 1;
            const sub = (x >>> 9) & 1;
            const rn = (x >>> 6) & 7;
            const a = this.r[(x >>> 3) & 7] | 0;
            const b = imm ? rn : this.r[rn] | 0;
            const res = sub ? (a - b) | 0 : (a + b) | 0;
            if (sub) this.subFlags(a, b, res); else this.addFlags(a, b, res);
            this.r[x & 7] = res;
          };
        }
        // LSL/LSR/ASR rd, rs, #imm
        return (x) => {
          const amount = (x >>> 6) & 0x1f;
          const rs = this.r[(x >>> 3) & 7] | 0;
          let res = rs;
          if (op === 0) {
            if (amount) { this.setC((rs & (1 << (32 - amount))) !== 0); res = (rs << amount) | 0; }
          } else if (op === 1) {
            if (amount === 0) { res = 0; this.setC(rs < 0); }
            else { this.setC((rs & (1 << (amount - 1))) !== 0); res = (rs >>> amount) | 0; }
          } else {
            if (amount === 0) { res = rs < 0 ? -1 : 0; this.setC(rs < 0); }
            else { this.setC((rs & (1 << (amount - 1))) !== 0); res = (rs >> amount) | 0; }
          }
          this.setNZ(res);
          this.r[x & 7] = res;
        };
      }
      case 0x2:
      case 0x3: {
        const op = (instr >>> 11) & 3;
        return (x) => {
          const rd = (x >>> 8) & 7;
          const imm = x & 0xff;
          const a = this.r[rd] | 0;
          let res: number;
          switch (op) {
            case 0: res = imm; this.setNZ(res); this.r[rd] = res; return;
            case 1: res = (a - imm) | 0; this.subFlags(a, imm, res); return;
            case 2: res = (a + imm) | 0; this.addFlags(a, imm, res); this.r[rd] = res; return;
            default: res = (a - imm) | 0; this.subFlags(a, imm, res); this.r[rd] = res; return;
          }
        };
      }
      case 0x4: {
        if ((instr & 0x0800) === 0) {
          if ((instr & 0x0400) === 0) {
            return (x) => this.thumbALU((x >>> 6) & 0xf, x & 7, (x >>> 3) & 7);
          }
          // Hi-register ops / BX
          return (x) => {
            const op = (x >>> 8) & 3;
            const rd = ((x >>> 4) & 8) | (x & 7);
            const rs = (x >>> 3) & 0xf;
            const a = rd === 15 ? this.pc | 0 : this.r[rd] | 0;
            const b = rs === 15 ? this.pc | 0 : this.r[rs] | 0;
            switch (op) {
              case 0: {
                const res = (a + b) | 0;
                if (rd === 15) this.writePC(res & ~1);
                else this.r[rd] = res;
                return;
              }
              case 1: {
                const res = (a - b) | 0;
                this.subFlags(a, b, res);
                return;
              }
              case 2:
                if (rd === 15) this.writePC(b & ~1);
                else this.r[rd] = b;
                return;
              default:
                this.thumb = (b & 1) !== 0;
                if (this.thumb) this.cpsr |= T; else this.cpsr &= ~T;
                this.writePC(b);
                return;
            }
          };
        }
        // LDR rd, [pc, #imm]
        return (x) => {
          const rd = (x >>> 8) & 7;
          const addr = ((this.pc & ~2) + ((x & 0xff) << 2)) >>> 0;
          this.r[rd] = this.bus.read32(addr) | 0;
          this.bus.internal(1);
        };
      }
      case 0x5: {
        const sub = (instr >>> 9) & 7;
        switch (sub) {
          case 0: return (x) => this.bus.write32(((this.r[(x >>> 3) & 7] + this.r[(x >>> 6) & 7]) >>> 0), this.r[x & 7] >>> 0);
          case 1: return (x) => this.bus.write16(((this.r[(x >>> 3) & 7] + this.r[(x >>> 6) & 7]) >>> 0), this.r[x & 7] & 0xffff);
          case 2: return (x) => this.bus.write8(((this.r[(x >>> 3) & 7] + this.r[(x >>> 6) & 7]) >>> 0), this.r[x & 7] & 0xff);
          case 3: return (x) => { this.r[x & 7] = (this.bus.read8(((this.r[(x >>> 3) & 7] + this.r[(x >>> 6) & 7]) >>> 0)) << 24) >> 24; this.bus.internal(1); };
          case 4: return (x) => { this.r[x & 7] = this.loadWord((this.r[(x >>> 3) & 7] + this.r[(x >>> 6) & 7]) >>> 0); this.bus.internal(1); };
          case 5: return (x) => { this.r[x & 7] = this.bus.read16(((this.r[(x >>> 3) & 7] + this.r[(x >>> 6) & 7]) >>> 0)) & 0xffff; this.bus.internal(1); };
          case 6: return (x) => { this.r[x & 7] = this.bus.read8(((this.r[(x >>> 3) & 7] + this.r[(x >>> 6) & 7]) >>> 0)) & 0xff; this.bus.internal(1); };
          default: return (x) => { this.r[x & 7] = (this.bus.read16(((this.r[(x >>> 3) & 7] + this.r[(x >>> 6) & 7]) >>> 0)) << 16) >> 16; this.bus.internal(1); };
        }
      }
      case 0x6:
      case 0x7: {
        const byte = nibble === 0x7;
        const load = (instr & 0x0800) !== 0;
        return (x) => {
          const imm = (x >>> 6) & 0x1f;
          const rb = this.r[(x >>> 3) & 7] | 0;
          const addr = (rb + (byte ? imm : imm << 2)) >>> 0;
          if (load) {
            this.r[x & 7] = byte
              ? this.bus.read8(addr)
              : this.loadWord(addr);
            this.bus.internal(1);
          } else {
            if (byte) this.bus.write8(addr, this.r[x & 7] & 0xff);
            else this.bus.write32(addr, this.r[x & 7] >>> 0);
          }
        };
      }
      case 0x8: {
        const load = (instr & 0x0800) !== 0;
        return (x) => {
          const imm = (x >>> 6) & 0x1f;
          const rb = this.r[(x >>> 3) & 7] | 0;
          const addr = (rb + (imm << 1)) >>> 0;
          if (load) {
            this.r[x & 7] = this.bus.read16(addr) & 0xffff;
            this.bus.internal(1);
          } else {
            this.bus.write16(addr, this.r[x & 7] & 0xffff);
          }
        };
      }
      case 0x9: {
        const load = (instr & 0x0800) !== 0;
        return (x) => {
          const rd = (x >>> 8) & 7;
          const addr = (this.r[13] + ((x & 0xff) << 2)) >>> 0;
          if (load) {
            this.r[rd] = this.bus.read32(addr) | 0;
            this.bus.internal(1);
          } else {
            this.bus.write32(addr, this.r[rd] >>> 0);
          }
        };
      }
      case 0xa: {
        const sp = (instr & 0x0800) !== 0;
        return (x) => {
          const base = sp ? this.r[13] | 0 : (this.pc & ~2);
          this.r[(x >>> 8) & 7] = (base + ((x & 0xff) << 2)) | 0;
        };
      }
      case 0xb: {
        const h = (instr >>> 8) & 0xf;
        if (h === 0x0) {
          return (x) => {
            const imm = (x & 0x7f) << 2;
            this.r[13] = (this.r[13] + ((x & 0x80) ? -imm : imm)) | 0;
          };
        }
        if ((h & 0x6) === 0x4) {
          const load = (h & 0x8) !== 0;
          return (x) => {
            const list = x & 0xff;
            const rbit = (x >>> 8) & 1;
            let sp = this.r[13] | 0;
            if (!load) {
              let count = rbit;
              for (let b = list; b; b >>= 1) count += b & 1;
              sp = (sp - count * 4) | 0;
              let addr = sp >>> 0;
              for (let reg = 0; reg < 8; reg++) {
                if (list & (1 << reg)) { this.bus.write32(addr, this.r[reg] >>> 0); addr += 4; }
              }
              if (rbit) this.bus.write32(addr, this.r[14] >>> 0);
              this.r[13] = sp;
            } else {
              let addr = sp >>> 0;
              for (let reg = 0; reg < 8; reg++) {
                if (list & (1 << reg)) { this.r[reg] = this.bus.read32(addr) | 0; addr += 4; }
              }
              if (rbit) {
                const v = this.bus.read32(addr) >>> 0;
                addr += 4;
                this.writePC(v & ~1);
              }
              this.r[13] = addr | 0;
              this.bus.internal(1);
            }
          };
        }
        return () => {};
      }
      case 0xc: {
        const load = (instr & 0x0800) !== 0;
        return (x) => {
          const rb = (x >>> 8) & 7;
          const list = x & 0xff;
          let addr = this.r[rb] >>> 0;
          if (list === 0) {
            // Empty list: transfers r15 and moves the base by 0x40.
            if (load) this.writePC(this.bus.read32(addr));
            else this.bus.write32(addr, (this.pc + 2) >>> 0);
            this.r[rb] = (this.r[rb] + 0x40) | 0;
            return;
          }
          if (load) {
            for (let reg = 0; reg < 8; reg++) {
              if (list & (1 << reg)) { this.r[reg] = this.bus.read32(addr) | 0; addr += 4; }
            }
            // A loaded base register keeps the loaded value.
            if (!(list & (1 << rb))) this.r[rb] = addr | 0;
            this.bus.internal(1);
          } else {
            let first = true;
            const newBase = (addr + count8(list) * 4) | 0;
            for (let reg = 0; reg < 8; reg++) {
              if (list & (1 << reg)) {
                const v = reg === rb ? (first ? this.r[rb] : newBase) : this.r[reg];
                this.bus.write32(addr, v >>> 0);
                addr += 4;
                first = false;
              }
            }
            this.r[rb] = newBase;
          }
        };
      }
      case 0xd: {
        const cond = (instr >>> 8) & 0xf;
        if (cond === 0xf) return (x) => this.swi(x & 0xff);
        if (cond === 0xe) return (x) => this.armUndefined(x);
        return (x) => {
          if (this.condPass(cond)) {
            const off = ((x & 0xff) << 24) >> 24;
            this.writePC((this.pc + (off << 1)) | 0);
          }
        };
      }
      case 0xe:
        return (x) => {
          const off = ((x & 0x7ff) << 21) >> 21;
          this.writePC((this.pc + (off << 1)) | 0);
        };
      default: {
        // 0xf: BL prefix (bit11=0) / suffix (bit11=1)
        const second = (instr & 0x0800) !== 0;
        if (!second) {
          return (x) => {
            const off = ((x & 0x7ff) << 21) >> 21;
            this.r[14] = (this.pc + (off << 12)) | 0;
          };
        }
        return (x) => {
          const target = (this.r[14] + ((x & 0x7ff) << 1)) | 0;
          this.r[14] = ((this.pc - 2) | 1) | 0;
          this.writePC(target);
        };
      }
    }
  }
}

function count8(v: number): number {
  let n = 0;
  for (; v; v >>= 1) n += v & 1;
  return n;
}
