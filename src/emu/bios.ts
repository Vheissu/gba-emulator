// High-level-emulated BIOS. Two parts:
//
// 1. A tiny *synthesized* BIOS image (16KB) that contains a real ARM IRQ
//    shim at vector 0x18. This exists so IRQ exceptions can vector into
//    BIOS memory exactly like hardware; the shim reproduces the real
//    BIOS behaviour (update the flag mirror at 0x03007FF8, then call the
//    user handler at 0x03007FFC).
// 2. SWI calls are intercepted in JS (see CPU.swi): no vectoring needed.

import { Bus } from "./bus";
import { CPU, MODE_SYS, MODE_IRQ, MODE_SVC } from "./cpu";

// ---------------------------------------------------------------------------
// Synthetic BIOS image
// ---------------------------------------------------------------------------

function u32(...v: number[]): number[] { return v; }

export function buildSyntheticBios(): Uint8Array {
  const bios = new Uint8Array(0x4000);
  const w = (off: number, v: number) => {
    bios[off] = v & 0xff;
    bios[off + 1] = (v >>> 8) & 0xff;
    bios[off + 2] = (v >>> 16) & 0xff;
    bios[off + 3] = v >>> 24;
  };

  // Exception vectors.
  w(0x00, 0xea000000 + ((0x30 - 2) & 0x00ffffff)); // reset -> branch to 0x30-ish (unused normally)
  w(0x04, 0xe12fff1e); // undefined: bx lr
  w(0x08, 0xe12fff1e); // swi: bx lr (HLE SWIs bypass this anyway)
  w(0x0c, 0xe12fff1e); // prefetch abort
  w(0x10, 0xe12fff1e); // data abort
  w(0x14, 0xe12fff1e); // reserved
  // 0x18: IRQ shim (see below)
  w(0x1c, 0xe12fff1e); // fiq

  // IRQ shim at 0x18 would need the branch; place code at 0x18 directly is
  // impossible (vector is a single instruction). Put a branch to 0x40.
  w(0x18, 0xea000000 | ((0x40 - 0x18 - 8) >> 2 & 0x00ffffff)); // b 0x40

  // Reset stub at 0x30: jump to 0x08000000 (skips nothing else; machine
  // normally bypasses BIOS entirely).
  w(0x30, 0xe3a0f402); // mov pc, #0x08000000  (imm 8 ror 24 -> rot field 12)
  w(0x34, 0xeafffffe); // b .

  // IRQ shim at 0x40.
  const code = u32(
    0xe92d500f, // stmfd sp!, {r0-r3, r12, lr}
    0xe59f0034, // ldr r0, [pc, #0x34]   -> 0x04000200
    0xe1d010b2, // ldrh r1, [r0, #2]     IF
    0xe1d020b0, // ldrh r2, [r0]         IE
    0xe0011002, // and r1, r1, r2        received = IE & IF
    0xe59f2028, // ldr r2, [pc, #0x28]   -> 0x03007FF8
    0xe1d230b0, // ldrh r3, [r2]
    0xe1833001, // orr r3, r3, r1
    0xe1c230b0, // strh r3, [r2]
    0xe592c004, // ldr r12, [r2, #4]     user handler ptr (0x03007FFC)
    0xe1a0e00f, // mov lr, pc
    0xe12fff1c, // bx r12
    0xe8bd500f, // ldmfd sp!, {r0-r3, r12, lr}
    0xe25ef004, // subs pc, lr, #4
  );
  code.forEach((v, i) => w(0x40 + i * 4, v));

  // Literal pool: pc during exec = instrAddr + 8.
  // ldr r0 at 0x44: pc=0x4c -> target 0x4c+0x34 = 0x80.
  // ldr r2 at 0x58: pc=0x60 -> target 0x60+0x28 = 0x88.
  w(0x80, 0x04000200);
  w(0x88, 0x03007ff8);

  return bios;
}

// ---------------------------------------------------------------------------
// HLE SWI implementations
// ---------------------------------------------------------------------------

export class BiosHLE {
  cpu!: CPU;
  bus!: Bus;

  /** IntrWait bookkeeping. */
  intrWaitFlags = 0;
  intrWaitDiscard = 0;
  intrWaiting = false;

  reset(): void {
    this.intrWaitFlags = 0;
    this.intrWaiting = false;
  }

  private rd16(addr: number): number {
    return this.bus.peek16(addr) & 0xffff;
  }
  private rd32(addr: number): number {
    return this.bus.peek32(addr) >>> 0;
  }
  private wr16(addr: number, v: number): void {
    this.bus.poke16(addr, v);
  }
  private wr32(addr: number, v: number): void {
    this.bus.poke32(addr, v >>> 0);
  }

  swi(num: number): void {
    const r = this.cpu.r;
    switch (num) {
      case 0x00: this.softReset(); return;
      case 0x01: this.registerRamReset(r[0]); return;
      case 0x02: case 0x03: this.cpu.halted = true; return;
      case 0x04: this.intrWait(r[0] & 1, r[1] & 0x3fff); return;
      case 0x05: this.intrWait(1, 1); return;
      case 0x06: { // Div r0/r1
        const a = r[0] | 0, b = r[1] | 0;
        if (b === 0) { r[0] = a < 0 ? 1 : -1; r[1] = a; r[3] = 1; return; }
        const q = (a / b) | 0;
        r[0] = q; r[1] = (a - q * b) | 0; r[3] = Math.abs(q);
        return;
      }
      case 0x07: { // DivArm: r1/r0
        const b = r[0] | 0, a = r[1] | 0;
        if (b === 0) { r[0] = a < 0 ? 1 : -1; r[1] = a; r[3] = 1; return; }
        const q = (a / b) | 0;
        r[0] = q; r[1] = (a - q * b) | 0; r[3] = Math.abs(q);
        return;
      }
      case 0x08: r[0] = Math.floor(Math.sqrt(r[0] >>> 0)); return;
      case 0x09: {
        const t = r[0] | 0;
        r[0] = Math.round(Math.atan2(t, 65536) * 0x8000 / Math.PI);
        return;
      }
      case 0x0a: {
        const x = r[0] | 0, y = r[1] | 0;
        r[0] = Math.round(Math.atan2(y, x) * 0x8000 / Math.PI) & 0xffff;
        r[0] = (r[0] << 16) >> 16;
        return;
      }
      case 0x0b: this.cpuSet(r[0] >>> 0, r[1] >>> 0, r[2] >>> 0); return;
      case 0x0c: this.cpuFastSet(r[0] >>> 0, r[1] >>> 0, r[2] >>> 0); return;
      case 0x0d: r[0] = 0xbaae187f; return; // GetBiosChecksum (fixed real value)
      case 0x0e: this.bgAffineSet(r[0] >>> 0, r[1] >>> 0, r[2] | 0); return;
      case 0x0f: this.objAffineSet(r[0] >>> 0, r[1] >>> 0, r[2] | 0, r[3] | 0); return;
      case 0x10: this.bitUnPack(r[0] >>> 0, r[1] >>> 0, r[2] >>> 0); return;
      case 0x11: this.lz77(r[0] >>> 0, r[1] >>> 0, false); return;
      case 0x12: this.lz77(r[0] >>> 0, r[1] >>> 0, true); return;
      case 0x13: this.huffUnComp(r[0] >>> 0, r[1] >>> 0); return;
      case 0x14: this.rlUnComp(r[0] >>> 0, r[1] >>> 0, false); return;
      case 0x15: this.rlUnComp(r[0] >>> 0, r[1] >>> 0, true); return;
      case 0x16: this.diffUnfilter(r[0] >>> 0, r[1] >>> 0, 1, false); return;
      case 0x17: this.diffUnfilter(r[0] >>> 0, r[1] >>> 0, 1, true); return;
      case 0x18: this.diffUnfilter(r[0] >>> 0, r[1] >>> 0, 2, false); return;
      case 0x19: r[0] = 0x200; return; // SoundBias
      case 0x1f: this.midiKey2Freq(); return;
      case 0x26: this.cpu.halted = true; return; // HardReset-adjacent / CustomHalt
      case 0x27: r[0] = 0; return; // CustomHalt / others
      // Sound-driver SWIs (0x1a-0x1e, 0x20-0x25) and misc: safe no-ops.
      default: return;
    }
  }

  /** Called by the machine after each IRQ fires; resumes IntrWait. */
  checkIntrWait(): void {
    if (!this.intrWaiting) return;
    const flags = this.rd16(0x03007ff8);
    if ((flags & this.intrWaitFlags) !== 0) {
      if (this.intrWaitDiscard) this.wr16(0x03007ff8, flags & ~this.intrWaitFlags);
      this.intrWaiting = false;
      this.cpu.halted = false;
    }
  }

  private intrWait(discard: number, target: number): void {
    const flags = this.rd16(0x03007ff8);
    if ((flags & target) !== 0) {
      if (discard) this.wr16(0x03007ff8, flags & ~target);
      return;
    }
    this.intrWaitFlags = target;
    this.intrWaitDiscard = discard;
    this.intrWaiting = true;
    this.cpu.halted = true;
  }

  private softReset(): void {
    // Byte at 0x03007FFA selects EWRAM (nonzero) vs ROM entry.
    const toRam = this.bus.peek16(0x03007ffa) & 0xff;
    // Post-boot register state
    for (let i = 0; i < 13; i++) this.cpu.r[i] = 0;
    this.cpu.r[13] = 0x03007f00;
    this.cpu.pc = toRam ? 0x02000000 : 0x08000000;
    this.cpu.flush();
  }

  private registerRamReset(flags: number): void {
    const b = this.bus;
    if (flags & 0x01) b.ewram.fill(0);
    if (flags & 0x02) b.iwram.fill(0, 0, 0x7e00); // keep BIOS area
    if (flags & 0x04) b.pal.fill(0);
    if (flags & 0x08) b.vram.fill(0);
    if (flags & 0x10) b.oam.fill(0);
    if (flags & 0x80) {
      b.iwram.fill(0, 0, 0x7e00);
      b.ewram.fill(0);
    }
  }

  private cpuSet(src: number, dst: number, ctrl: number): void {
    const count = ctrl & 0x1fffff;
    const word = (ctrl & 0x01000000) !== 0;   // 1 = 32-bit, 0 = 16-bit
    const fixed = (ctrl & 0x02000000) !== 0;  // 1 = fill
    if (word) {
      const fill = this.rd32(src);
      for (let i = 0; i < count; i++) {
        this.wr32(dst + i * 4, fixed ? fill : this.rd32(src + i * 4));
      }
    } else {
      const fill = this.rd16(src);
      for (let i = 0; i < count; i++) {
        this.wr16(dst + i * 2, fixed ? fill : this.rd16(src + i * 2));
      }
    }
  }

  private cpuFastSet(src: number, dst: number, ctrl: number): void {
    let count = ctrl & 0x1fffff;
    const fixed = (ctrl & 0x01000000) !== 0;
    count = (count + 7) & ~7;
    const fill = this.rd32(src);
    for (let i = 0; i < count; i++) {
      this.wr32(dst + i * 4, fixed ? fill : this.rd32(src + i * 4));
    }
  }

  private lz77(src: number, dst: number, vram: boolean): void {
    const header = this.rd32(src);
    let size = header >>> 8;
    src += 4;
    let out = 0;
    while (out < size) {
      const flags = this.bus.peek16(src) & 0xff;
      src++;
      for (let i = 0; i < 8 && out < size; i++) {
        if (flags & (0x80 >>> i)) {
          const b0 = this.bus.peek16(src) & 0xff;
          const b1 = this.bus.peek16(src + 1) & 0xff;
          src += 2;
          const len = (b0 >>> 4) + 3;
          const disp = ((b0 & 0xf) << 8) | b1;
          for (let j = 0; j < len; j++) {
            const b = this.readByte(dst + out - disp - 1);
            this.writeByte(dst + out, b);
            out++;
          }
        } else {
          const b = this.bus.peek16(src) & 0xff;
          src++;
          this.writeByte(dst + out, b);
          out++;
        }
      }
    }
  }

  private readByte(addr: number): number {
    const a = addr & ~1;
    const w = this.rd16(a);
    return (addr & 1) ? w >>> 8 : w & 0xff;
  }

  private writeByte(addr: number, v: number): void {
    // Byte-accurate store via 16-bit rmw on non-VRAM-safe memories is fine
    // for our purposes (VRAM byte writes mirror; LZ77Vram targets VRAM so
    // write a halfword containing the byte in the low half).
    const a = addr & ~1;
    const cur = this.rd16(a);
    this.wr16(a, (addr & 1) ? (cur & 0xff) | (v << 8) : (cur & 0xff00) | v);
  }

  private rlUnComp(src: number, dst: number, vram: boolean): void {
    void vram;
    const header = this.rd32(src);
    let size = header >>> 8;
    src += 4;
    let out = 0;
    while (out < size) {
      const flag = this.bus.peek16(src) & 0xff;
      src++;
      if (flag & 0x80) {
        const count = (flag & 0x7f) + 3;
        const b = this.bus.peek16(src) & 0xff;
        src++;
        for (let i = 0; i < count; i++) { this.writeByte(dst + out, b); out++; }
      } else {
        const count = (flag & 0x7f) + 1;
        for (let i = 0; i < count; i++) {
          this.writeByte(dst + out, this.bus.peek16(src) & 0xff);
          src++;
          out++;
        }
      }
    }
    void size;
  }

  private huffUnComp(src: number, dst: number): void {
    const header = this.rd32(src);
    const size = header >>> 8;
    const width = header & 0xf; // 4 or 8 bit symbols
    src += 4;
    const treeBase = src;
    const treeSize = ((this.bus.peek16(src) & 0xff) / 2 + 1) * 2;
    src += treeSize;
    let out = 0;
    let bits = 0;
    let bitCount = 0;
    while (out < size) {
      if (bitCount === 0) {
        bits = this.rd32(src);
        src += 4;
        bitCount = 32;
      }
      // Walk the huffman tree
      let node = treeBase;
      for (;;) {
        const nodeVal = this.bus.peek16(node) & 0xff;
        const bit = (bits >>> 31) & 1;
        bits <<= 1;
        bitCount--;
        const childOff = node & ~1; // nodes are byte-sized; offset stored in high bits
        const next = (nodeVal >>> (bit === 0 ? 6 : 4)) & 1; // end flags
        const off = (nodeVal & 0x3f) * 2;
        const childAddr = childOff + off + 2 + bit;
        if (next) {
          const sym = this.bus.peek16((childOff + off + 2) + bit * 0) & 0xff;
          void sym;
          // The child is at (node&~1) + offset*2 + 2 + bit
          const c = this.bus.peek16(childAddr - 2 + 2) & 0xff;
          void c;
          const leafAddr = (node & ~1) + (nodeVal & 0x3f) * 2 + 2 + bit;
          const v = this.bus.peek16(leafAddr) & 0xff;
          if (width === 8) {
            this.writeByte(dst + out, v);
            out++;
          } else {
            // 4-bit symbols: two per byte
            if (out & 1) {
              const a = dst + (out & ~1);
              const cur = this.rd16(a);
              this.wr16(a, (cur & 0xff) | ((v & 0xf) << 8));
            } else {
              this.writeByte(dst + out, v & 0xf);
            }
            out++;
          }
          break;
        }
        node = childAddr;
      }
    }
  }

  private diffUnfilter(src: number, dst: number, unit: 1 | 2, vram: boolean): void {
    void vram;
    const header = this.rd32(src);
    const size = header >>> 8;
    src += 4;
    if (unit === 1) {
      let prev = 0;
      for (let i = 0; i < size; i++) {
        prev = (prev + (this.bus.peek16(src + i) & 0xff)) & 0xff;
        this.writeByte(dst + i, prev);
      }
    } else {
      let prev = 0;
      for (let i = 0; i < size; i += 2) {
        prev = (prev + this.rd16(src + i)) & 0xffff;
        this.wr16(dst + i, prev);
      }
    }
  }

  private bitUnPack(src: number, dst: number, infoAddr: number): void {
    const srcLen = this.rd16(infoAddr);
    const srcWidth = this.bus.peek16(infoAddr + 2) & 0xff;
    const dstWidth = this.bus.peek16(infoAddr + 3) & 0xff;
    const dstOff = this.rd32(infoAddr + 4) & 0x7fffffff;
    const dstZeroFill = (this.rd32(infoAddr + 4) & 0x80000000) !== 0;
    void dstZeroFill;

    let outBit = 0;
    const mask = (1 << dstWidth) - 1;
    for (let i = 0; i < srcLen; i++) {
      const byte = this.bus.peek16(src + i) & 0xff;
      for (let b = 0; b < 8; b += srcWidth) {
        const v = (byte >>> b) & ((1 << srcWidth) - 1);
        if (v === 0 && dstOff === 0) { outBit += dstWidth; continue; }
        const value = v + dstOff;
        // Write value at bit offset outBit
        const byteOff = outBit >> 3;
        const shift = outBit & 7;
        const a = dst + byteOff;
        const cur = this.rd16(a) | (this.rd16(a + 2) << 16);
        const nv = (cur & ~(mask << shift)) | ((value & mask) << shift);
        this.wr16(a, nv & 0xffff);
        this.wr16(a + 2, (nv >>> 16) & 0xffff);
        outBit += dstWidth;
      }
    }
  }

  private bgAffineSet(src: number, dst: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const cx = this.rd32(src + i * 20) | 0;
      const cy = this.rd32(src + i * 20 + 4) | 0;
      const dispx = (this.rd16(src + i * 20 + 8) << 16) >> 16;
      const dispy = (this.rd16(src + i * 20 + 10) << 16) >> 16;
      const scaleX = this.rd32(src + i * 20 + 12) | 0;
      const scaleY = this.rd32(src + i * 20 + 16) | 0;
      const angle = this.rd16(src + i * 20 + 18) & 0xffff;

      const theta = (angle >>> 8) * Math.PI / 128 + ((angle & 0xff) / 256) * Math.PI / 128;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const pa = Math.round(cos * scaleX / 256) | 0;
      const pb = Math.round(-sin * scaleX / 256) | 0;
      const pc = Math.round(sin * scaleY / 256) | 0;
      const pd = Math.round(cos * scaleY / 256) | 0;
      this.wr16(dst + i * 16, pa & 0xffff);
      this.wr16(dst + i * 16 + 2, pb & 0xffff);
      this.wr16(dst + i * 16 + 4, pc & 0xffff);
      this.wr16(dst + i * 16 + 6, pd & 0xffff);
      const dx = cx + (-pa * dispx - pb * dispy) / 256;
      const dy = cy + (-pc * dispx - pd * dispy) / 256;
      this.wr32(dst + i * 16 + 8, Math.round(dx));
      this.wr32(dst + i * 16 + 12, Math.round(dy));
    }
  }

  private objAffineSet(src: number, dst: number, count: number, offset: number): void {
    for (let i = 0; i < count; i++) {
      const scaleX = this.rd32(src + i * 8) | 0;
      const scaleY = this.rd32(src + i * 8 + 4) | 0;
      const angle = this.rd16(src + i * 8 + 6) & 0xffff;
      const theta = angle * Math.PI / 0x8000;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const pa = Math.round(cos * scaleX / 256) & 0xffff;
      const pb = Math.round(-sin * scaleX / 256) & 0xffff;
      const pc = Math.round(sin * scaleY / 256) & 0xffff;
      const pd = Math.round(cos * scaleY / 256) & 0xffff;
      const base = dst + i * offset;
      this.wr16(base, pa);
      this.wr16(base + 2, pb);
      this.wr16(base + 4, pc);
      this.wr16(base + 6, pd);
    }
  }

  private midiKey2Freq(): void {
    const r = this.cpu.r;
    const wave = this.rd32(r[0] >>> 0);   // wave RAM pointer -> ignore content
    void wave;
    const key = r[1] | 0;
    const fine = r[2] | 0;
    // freq = 2^((key/16 + fine/256 - 13)/12 + ...) — approximate with the
    // documented formula: result in 1/1024 semitone-ish fixed point.
    const note = key / 16 + fine / 256;
    r[0] = Math.round(Math.pow(2, (note - 45) / 12) * 32768 * 4096 / 16777216 * 1024);
  }

  /** Apply post-BIOS register state so the machine can boot without one. */
  applyPostBootState(): void {
    const cpu = this.cpu;
    cpu.cpsr = MODE_SYS | 0x00; // system mode, IRQ+FIQ enabled
    cpu.r[0] = 0x08000000;
    cpu.r[1] = 0x000000ea;
    for (let i = 2; i <= 12; i++) cpu.r[i] = 0;
    // Stacks per mode
    cpu.r[13] = 0x03007f00;                    // usr/sys SP
    // Switch to IRQ to set its SP, then SVC, then back to SYS.
    cpu.writeCPSR(MODE_IRQ | 0x00, 0x1);
    cpu.r[13] = 0x03007fa0;
    cpu.writeCPSR(MODE_SVC | 0x00, 0x1);
    cpu.r[13] = 0x03007fe0;
    cpu.writeCPSR(MODE_SYS | 0x00, 0x1);
    cpu.pc = 0x08000000;
    (this.cpu as unknown as { flush: () => void }).flush();
  }
}
