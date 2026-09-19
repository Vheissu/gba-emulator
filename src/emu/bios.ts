// High-level-emulated BIOS. Two parts:
//
// 1. A tiny *synthesized* BIOS image (16KB) that contains a real ARM IRQ
//    shim at vector 0x18. This exists so IRQ exceptions can vector into
//    BIOS memory exactly like hardware; the shim reproduces the real
//    BIOS behaviour (update the flag mirror at 0x03007FF8, then call the
//    user handler at 0x03007FFC).
// 2. SWI calls are intercepted in JS (see CPU.swi): no vectoring needed.

import type { Bus } from "./bus";
import type { CPU } from "./cpu";
import type { System } from "./system";
import type { StateReader, StateWriter } from "./state";

/** What a real BIOS leaves on its read latch after a SWI returns. */
const LATCH_AFTER_SWI = 0xe3a02004;

// ---------------------------------------------------------------------------
// Synthetic BIOS image
// ---------------------------------------------------------------------------

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
  w(0x30, 0xe3a0f302); // mov pc, #0x08000000  (0x02 ror 6)
  w(0x34, 0xeafffffe); // b .

  // IRQ shim at 0x40.
  const code = [
    0xe92d500f, // stmfd sp!, {r0-r3, r12, lr}
    0xe59f0034, // ldr r0, [pc, #0x34]   -> 0x04000200
    0xe1d010b2, // ldrh r1, [r0, #2]     IF
    0xe1d020b0, // ldrh r2, [r0]         IE
    0xe0011002, // and r1, r1, r2        received = IE & IF
    0xe59f202c, // ldr r2, [pc, #0x2c]   -> 0x03007FF8
    0xe1d230b0, // ldrh r3, [r2]
    0xe1833001, // orr r3, r3, r1
    0xe1c230b0, // strh r3, [r2]
    0xe592c004, // ldr r12, [r2, #4]     user handler ptr (0x03007FFC)
    0xe1a0e00f, // mov lr, pc
    0xe12fff1c, // bx r12
    0xe8bd500f, // ldmfd sp!, {r0-r3, r12, lr}
    0xe25ef004, // subs pc, lr, #4
  ];
  code.forEach((v, i) => w(0x40 + i * 4, v));

  // Literal pool: pc during exec = instrAddr + 8.
  // ldr r0 at 0x44: pc=0x4c -> target 0x4c+0x34 = 0x80.
  // ldr r2 at 0x54: pc=0x5c -> target 0x5c+0x2c = 0x88.
  w(0x80, 0x04000200);
  w(0x88, 0x03007ff8);

  // The pipeline prefetches two words past the final `subs pc`; games that
  // probe the BIOS read latch expect the real BIOS's value there.
  w(0x7c, 0xe55ec002);

  return bios;
}

// ---------------------------------------------------------------------------
// HLE SWI implementations
// ---------------------------------------------------------------------------

export class BiosHLE {
  cpu!: CPU;
  bus!: Bus;
  sys!: System;

  /** Flags an in-progress IntrWait is blocked on (0 = not waiting). */
  private waitFlags = 0;

  reset(): void {
    this.waitFlags = 0;
  }

  swi(num: number): void {
    const r = this.cpu.r;
    this.bus.setBiosLatch(LATCH_AFTER_SWI);
    switch (num) {
      case 0x00: this.softReset(); return;
      case 0x01: this.registerRamReset(r[0]); return;
      case 0x02: case 0x03: this.sys.halt(); return;
      case 0x04: this.intrWait(r[0] !== 0, r[1] & 0x3fff); return;
      case 0x05: this.intrWait(true, 1); return;
      case 0x06: this.div(r[0], r[1]); return;
      case 0x07: this.div(r[1], r[0]); return;
      case 0x08: r[0] = Math.floor(Math.sqrt(r[0] >>> 0)); return;
      case 0x09: r[0] = arcTan(r[0]); return;
      case 0x0a: r[0] = arcTan2(r[0], r[1]); return;
      case 0x0b: this.cpuSet(r[0] >>> 0, r[1] >>> 0, r[2]); return;
      case 0x0c: this.cpuFastSet(r[0] >>> 0, r[1] >>> 0, r[2]); return;
      case 0x0d: r[0] = 0xbaae187f; return; // GetBiosChecksum
      case 0x0e: this.bgAffineSet(r[0] >>> 0, r[1] >>> 0, r[2]); return;
      case 0x0f: this.objAffineSet(r[0] >>> 0, r[1] >>> 0, r[2], r[3]); return;
      case 0x10: this.bitUnPack(r[0] >>> 0, r[1] >>> 0, r[2] >>> 0); return;
      case 0x11: case 0x12: this.lz77(r[0] >>> 0, r[1] >>> 0); return;
      case 0x13: this.huffUnComp(r[0] >>> 0, r[1] >>> 0); return;
      case 0x14: case 0x15: this.rlUnComp(r[0] >>> 0, r[1] >>> 0); return;
      case 0x16: case 0x17: this.diffUnFilter(r[0] >>> 0, r[1] >>> 0, 1); return;
      case 0x18: this.diffUnFilter(r[0] >>> 0, r[1] >>> 0, 2); return;
      case 0x1f: this.midiKey2Freq(); return;
      // SoundBias and the sound-driver calls (0x19-0x1e, 0x20-0x2a) have no
      // effect worth modelling.
      default: return;
    }
  }

  // ---- system ---------------------------------------------------------------

  /** Blocks until one of `flags` shows up in the BIOS interrupt mirror at
   *  0x03007FF8 (maintained by the IRQ shim). Blocking is done by halting
   *  and re-running the SWI after each interrupt, like the BIOS's own loop. */
  private intrWait(discardOld: boolean, flags: number): void {
    const mirror = this.bus.peek16(0x03007ff8);
    const resumed = this.waitFlags === flags;
    if ((resumed || !discardOld) && mirror & flags) {
      this.bus.poke16(0x03007ff8, mirror & ~flags);
      this.waitFlags = 0;
      return;
    }
    if (!resumed) this.bus.poke16(0x03007ff8, mirror & ~flags);
    this.waitFlags = flags;
    this.sys.enableMaster();
    this.sys.halt();
    this.cpu.restartInstruction();
  }

  private softReset(): void {
    const toRam = this.bus.peek8(0x03007ffa) !== 0;
    this.bus.iwram.fill(0, 0x7e00);
    this.cpu.bootState(toRam ? 0x02000000 : 0x08000000);
  }

  private registerRamReset(flags: number): void {
    const b = this.bus;
    if (flags & 0x01) b.ewram.fill(0);
    if (flags & 0x02) b.iwram.fill(0, 0, 0x7e00); // top 0x200 belongs to the BIOS
    if (flags & 0x04) b.pal.fill(0);
    if (flags & 0x08) b.vram.fill(0);
    if (flags & 0x10) b.oam.fill(0);
    b.poke16(0x04000000, 0x0080);
  }

  private div(num: number, den: number): void {
    const r = this.cpu.r;
    if (den === 0) {
      // The real routine spins forever; hand back something harmless.
      r[0] = num < 0 ? -1 : 1; r[1] = num; r[3] = 1;
      return;
    }
    const q = (num / den) | 0;
    r[0] = q; r[1] = num % den; r[3] = Math.abs(q);
  }

  // ---- memory copies ----------------------------------------------------------

  private cpuSet(src: number, dst: number, ctrl: number): void {
    const count = ctrl & 0x1fffff;
    const fixed = (ctrl & 0x01000000) !== 0;
    const bus = this.bus;
    if (ctrl & 0x04000000) {
      src &= ~3; dst &= ~3;
      for (let i = 0; i < count; i++) bus.poke32(dst + i * 4, bus.peek32(fixed ? src : src + i * 4));
    } else {
      src &= ~1; dst &= ~1;
      for (let i = 0; i < count; i++) bus.poke16(dst + i * 2, bus.peek16(fixed ? src : src + i * 2));
    }
  }

  private cpuFastSet(src: number, dst: number, ctrl: number): void {
    const count = ((ctrl & 0x1fffff) + 7) & ~7; // always whole 8-word blocks
    const fixed = (ctrl & 0x01000000) !== 0;
    const bus = this.bus;
    src &= ~3; dst &= ~3;
    for (let i = 0; i < count; i++) bus.poke32(dst + i * 4, bus.peek32(fixed ? src : src + i * 4));
  }

  // ---- decompression ----------------------------------------------------------
  // All formats start with a 32-bit header: type in the low byte, output
  // size in the upper 24 bits.

  private lz77(src: number, dst: number): void {
    const bus = this.bus;
    const end = dst + (bus.peek32(src) >>> 8);
    src += 4;
    while (dst < end) {
      const flags = bus.peek8(src++);
      for (let bit = 0x80; bit && dst < end; bit >>= 1) {
        if (flags & bit) {
          const b0 = bus.peek8(src++), b1 = bus.peek8(src++);
          const from = dst - ((((b0 & 0xf) << 8) | b1) + 1);
          const len = (b0 >> 4) + 3;
          for (let j = 0; j < len && dst < end; j++, dst++) bus.poke8(dst, bus.peek8(from + j));
        } else {
          bus.poke8(dst++, bus.peek8(src++));
        }
      }
    }
  }

  private rlUnComp(src: number, dst: number): void {
    const bus = this.bus;
    const end = dst + (bus.peek32(src) >>> 8);
    src += 4;
    while (dst < end) {
      const flag = bus.peek8(src++);
      if (flag & 0x80) {
        const byte = bus.peek8(src++);
        for (let n = (flag & 0x7f) + 3; n > 0 && dst < end; n--) bus.poke8(dst++, byte);
      } else {
        for (let n = flag + 1; n > 0 && dst < end; n--) bus.poke8(dst++, bus.peek8(src++));
      }
    }
  }

  private huffUnComp(src: number, dst: number): void {
    const bus = this.bus;
    const header = bus.peek32(src);
    const width = header & 0xf;
    let remaining = header >>> 8;
    if (32 % width !== 0) return;
    // Tree nodes are bytes: bits 0-5 offset to the children, bit 7 / bit 6
    // flag the left / right child as a leaf.
    const root = src + 5;
    src += 5 + (bus.peek8(src + 4) << 1) + 1;
    let nodeAddr = root;
    let block = 0, filled = 0;
    while (remaining > 0) {
      let stream = bus.peek32(src);
      src += 4;
      for (let i = 0; i < 32 && remaining > 0; i++, stream <<= 1) {
        const node = bus.peek8(nodeAddr);
        const right = stream < 0 ? 1 : 0;
        const child = (nodeAddr & ~1) + (node & 0x3f) * 2 + 2 + right;
        if (!(node & (right ? 0x40 : 0x80))) { nodeAddr = child; continue; }
        block |= (bus.peek8(child) & ((1 << width) - 1)) << filled;
        filled += width;
        nodeAddr = root;
        if (filled === 32) {
          bus.poke32(dst, block);
          dst += 4; remaining -= 4;
          block = filled = 0;
        }
      }
    }
  }

  private diffUnFilter(src: number, dst: number, unit: 1 | 2): void {
    const bus = this.bus;
    const size = bus.peek32(src) >>> 8;
    src += 4;
    let acc = 0;
    for (let i = 0; i < size; i += unit) {
      if (unit === 1) {
        acc = (acc + bus.peek8(src + i)) & 0xff;
        bus.poke8(dst + i, acc);
      } else {
        acc = (acc + bus.peek16(src + i)) & 0xffff;
        bus.poke16(dst + i, acc);
      }
    }
  }

  private bitUnPack(src: number, dst: number, info: number): void {
    const bus = this.bus;
    let srcLen = bus.peek16(info);
    const srcWidth = bus.peek8(info + 2);
    const dstWidth = bus.peek8(info + 3);
    const offsetWord = bus.peek32(info + 4);
    const bias = offsetWord & 0x7fffffff;
    const biasZero = offsetWord > 0x7fffffff;
    if (!srcWidth || !dstWidth) return;

    let inByte = 0, inBits = 0, out = 0, outBits = 0;
    while (srcLen > 0 || inBits > 0) {
      if (inBits === 0) { inByte = bus.peek8(src++); inBits = 8; srcLen--; }
      let v = inByte & ((1 << srcWidth) - 1);
      inByte >>= srcWidth;
      inBits -= srcWidth;
      if (v || biasZero) v += bias;
      out |= v << outBits;
      outBits += dstWidth;
      if (outBits >= 32) {
        bus.poke32(dst, out);
        dst += 4;
        out = outBits = 0;
      }
    }
  }

  // ---- affine helpers ---------------------------------------------------------

  private bgAffineSet(src: number, dst: number, count: number): void {
    const bus = this.bus;
    for (; count > 0; count--, src += 20, dst += 16) {
      const ox = (bus.peek32(src) | 0) / 256, oy = (bus.peek32(src + 4) | 0) / 256;
      const cx = s16(bus.peek16(src + 8)), cy = s16(bus.peek16(src + 10));
      const sx = s16(bus.peek16(src + 12)) / 256, sy = s16(bus.peek16(src + 14)) / 256;
      const theta = ((bus.peek16(src + 16) >> 8) / 128) * Math.PI;
      const cos = Math.cos(theta), sin = Math.sin(theta);
      const a = cos * sx, b = -sin * sx, c = sin * sy, d = cos * sy;
      bus.poke16(dst, a * 256); bus.poke16(dst + 2, b * 256);
      bus.poke16(dst + 4, c * 256); bus.poke16(dst + 6, d * 256);
      bus.poke32(dst + 8, (ox - (a * cx + b * cy)) * 256);
      bus.poke32(dst + 12, (oy - (c * cx + d * cy)) * 256);
    }
  }

  private objAffineSet(src: number, dst: number, count: number, stride: number): void {
    const bus = this.bus;
    for (; count > 0; count--, src += 8, dst += stride * 4) {
      const sx = s16(bus.peek16(src)) / 256, sy = s16(bus.peek16(src + 2)) / 256;
      const theta = ((bus.peek16(src + 4) >> 8) / 128) * Math.PI;
      const cos = Math.cos(theta), sin = Math.sin(theta);
      bus.poke16(dst, cos * sx * 256);
      bus.poke16(dst + stride, -sin * sx * 256);
      bus.poke16(dst + stride * 2, sin * sy * 256);
      bus.poke16(dst + stride * 3, cos * sy * 256);
    }
  }

  private midiKey2Freq(): void {
    const r = this.cpu.r;
    const freq = this.bus.peek32((r[0] + 4) >>> 0);
    r[0] = freq / Math.pow(2, (180 - r[1] - r[2] / 256) / 12);
  }

  saveState(w: StateWriter): void { w.u16(this.waitFlags); }
  loadState(r: StateReader): void { this.waitFlags = r.u16(); }
}

function s16(v: number): number {
  return (v << 16) >> 16;
}

/** The BIOS's polynomial arctangent: 1.14 fixed-point in, angle out. */
function arcTan(i: number): number {
  const a = -(Math.imul(i, i) >> 14);
  let b = (Math.imul(0xa9, a) >> 14) + 0x390;
  for (const k of [0x91c, 0xfb6, 0x16aa, 0x2081, 0x3651, 0xa2f9]) b = (Math.imul(b, a) >> 14) + k;
  return Math.imul(i, b) >> 16;
}

function arcTan2(x: number, y: number): number {
  if (y === 0) return x >= 0 ? 0 : 0x8000;
  if (x === 0) return y >= 0 ? 0x4000 : 0xc000;
  const yx = () => arcTan(((y << 14) / x) | 0);
  const xy = () => arcTan(((x << 14) / y) | 0);
  if (y >= 0) {
    if (x >= 0) { if (x >= y) return yx(); }
    else if (-x >= y) return yx() + 0x8000;
    return 0x4000 - xy();
  }
  if (x <= 0) { if (-x > -y) return yx() + 0x8000; }
  else if (x >= -y) return yx() + 0x10000;
  return 0xc000 - xy();
}
