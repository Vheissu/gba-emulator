// Memory bus: address decode, waitstates, IO dispatch.
// GBA memory map (address bits 27..24 select the region):
//   0x0 BIOS (16K)   0x2 EWRAM (256K)  0x3 IWRAM (32K)  0x4 IO
//   0x5 PAL (1K)     0x6 VRAM (96K)    0x7 OAM (1K)
//   0x8-0xD ROM (up to 32M, WS0/WS1/WS2)   0xE SRAM/Flash

import type { PPU } from "./ppu";
import type { APU } from "./apu";
import type { System } from "./system";
import type { SaveDevice } from "./saves";
import type { Gpio } from "./gpio";
import type { StateReader, StateWriter } from "./state";

const WS_NONSEQ = [4, 3, 2, 8];
const WS_SEQ = [[2, 1], [4, 1], [8, 1]];

/** Value the real BIOS leaves on its read latch after booting a cartridge. */
const BIOS_LATCH_BOOT = 0xe129f000;

/** A 32-bit-aligned block of memory with byte/half/word views. */
class Mem {
  readonly u8: Uint8Array;
  readonly u16: Uint16Array;
  readonly u32: Uint32Array;
  constructor(size: number) {
    const buf = new ArrayBuffer((size + 3) & ~3);
    this.u8 = new Uint8Array(buf);
    this.u16 = new Uint16Array(buf);
    this.u32 = new Uint32Array(buf);
  }
}

export class Bus {
  ppu!: PPU;
  apu!: APU;
  sys!: System;
  save!: SaveDevice;
  gpio!: Gpio;

  /** Running cycle counter; every access and internal cycle adds to it. */
  cycles = 0;

  private biosMem = new Mem(0x4000);
  private ewramMem = new Mem(256 * 1024);
  private iwramMem = new Mem(32 * 1024);
  private palMem = new Mem(1024);
  private vramMem = new Mem(96 * 1024);
  private oamMem = new Mem(1024);
  private romMem = new Mem(4);

  readonly ewram = this.ewramMem.u8;
  readonly iwram = this.iwramMem.u8;
  readonly pal = this.palMem.u8;
  readonly vram = this.vramMem.u8;
  readonly oam = this.oamMem.u8;
  /** Palette as 256 BG + 256 OBJ 15-bit colours. */
  readonly pal16 = this.palMem.u16;
  readonly oam16 = this.oamMem.u16;
  rom: Uint8Array = this.romMem.u8;
  romSize = 0;

  /** Last value written to each IO halfword; used to widen byte writes to
   *  write-only registers. */
  private ioShadow = new Uint16Array(0x200);

  /** Brings timers/PPU/APU up to the current cycle before IO state that
   *  depends on them is touched. */
  ioSync: () => void = () => {};
  /** Fired when the BIOS interrupt-flag mirror (0x03007FF8) is written, so
   *  the HLE IntrWait can consume flags where the real BIOS loop would. */
  onIntrFlagsWritten: () => void = () => {};

  // Open-bus state.
  private lastFetched = 0;
  private biosLatch = BIOS_LATCH_BOOT;
  private inBios = false;
  private lastFetchEnd = -1;

  // Access cost tables indexed by region.
  private n16 = new Int32Array(16);
  private s16 = new Int32Array(16);
  private n32 = new Int32Array(16);
  private s32 = new Int32Array(16);
  private prefetch = false;

  constructor() {
    this.setWaitControl(0);
  }

  reset(): void {
    this.ewram.fill(0);
    this.iwram.fill(0);
    this.pal.fill(0);
    this.vram.fill(0);
    this.oam.fill(0);
    this.ioShadow.fill(0);
    this.cycles = 0;
    this.lastFetched = 0;
    this.biosLatch = BIOS_LATCH_BOOT;
    this.inBios = false;
    this.lastFetchEnd = -1;
    this.setWaitControl(0);
  }

  loadRom(data: Uint8Array): void {
    this.romMem = new Mem(data.length);
    this.romMem.u8.set(data);
    this.rom = this.romMem.u8;
    this.romSize = data.length;
  }

  setBios(image: Uint8Array): void {
    this.biosMem.u8.set(image.subarray(0, 0x4000));
  }

  /** Simulates the value a BIOS routine leaves on the BIOS read latch. */
  setBiosLatch(value: number): void {
    this.biosLatch = value >>> 0;
  }

  // ---- cycle accounting ---------------------------------------------------

  /** Recompute access costs from WAITCNT. */
  setWaitControl(waitcnt: number): void {
    const { n16, s16, n32, s32 } = this;
    n16.fill(1); s16.fill(1); n32.fill(1); s32.fill(1);
    // EWRAM is a 16-bit bus with 2 waits.
    n16[2] = s16[2] = 3;
    n32[2] = s32[2] = 6;
    for (let ws = 0; ws < 3; ws++) {
      const n = 1 + WS_NONSEQ[(waitcnt >>> (2 + ws * 3)) & 3];
      const s = 1 + WS_SEQ[ws][(waitcnt >>> (4 + ws * 3)) & 1];
      for (const region of [0x8 + ws * 2, 0x9 + ws * 2]) {
        n16[region] = n;
        s16[region] = s;
        n32[region] = n + s;
        s32[region] = s + s;
      }
    }
    const sram = 1 + WS_NONSEQ[waitcnt & 3];
    n16[0xe] = s16[0xe] = n32[0xe] = s32[0xe] = sram;
    n16[0xf] = s16[0xf] = n32[0xf] = s32[0xf] = sram;
    this.prefetch = (waitcnt & 0x4000) !== 0;
  }

  internal(n = 1): void {
    this.cycles += n;
  }

  // ---- uncharged reads ----------------------------------------------------

  private openBus(): number {
    return this.lastFetched;
  }

  private readBios32(addr: number): number {
    if (addr >= 0x4000) return this.openBus();
    if (!this.inBios) return this.biosLatch;
    return (this.biosLatch = this.biosMem.u32[addr >>> 2]);
  }

  private raw8(addr: number): number {
    switch (addr >>> 24) {
      case 0x0: return (this.readBios32(addr & ~3) >>> ((addr & 3) * 8)) & 0xff;
      case 0x2: return this.ewram[addr & 0x3ffff];
      case 0x3: return this.iwram[addr & 0x7fff];
      case 0x4: return (this.ioRead16(addr & ~1) >>> ((addr & 1) * 8)) & 0xff;
      case 0x5: return this.pal[addr & 0x3ff];
      case 0x6: return this.vram[vramOffset(addr)];
      case 0x7: return this.oam[addr & 0x3ff];
      case 0x8: case 0x9: case 0xa: case 0xb: case 0xc: case 0xd:
        return (this.romRead16(addr & ~1) >>> ((addr & 1) * 8)) & 0xff;
      case 0xe: case 0xf: return this.save.read8(addr & 0xffff);
    }
    return (this.openBus() >>> ((addr & 3) * 8)) & 0xff;
  }

  private raw16(addr: number): number {
    addr &= ~1;
    switch (addr >>> 24) {
      case 0x0: return (this.readBios32(addr & ~3) >>> ((addr & 2) * 8)) & 0xffff;
      case 0x2: return this.ewramMem.u16[(addr & 0x3ffff) >>> 1];
      case 0x3: return this.iwramMem.u16[(addr & 0x7fff) >>> 1];
      case 0x4: return this.ioRead16(addr);
      case 0x5: return this.pal16[(addr & 0x3ff) >>> 1];
      case 0x6: return this.vramMem.u16[vramOffset(addr) >>> 1];
      case 0x7: return this.oam16[(addr & 0x3ff) >>> 1];
      case 0x8: case 0x9: case 0xa: case 0xb: case 0xc: case 0xd:
        return this.romRead16(addr);
      case 0xe: case 0xf: return this.save.read8(addr & 0xffff) * 0x0101;
    }
    return (this.openBus() >>> ((addr & 2) * 8)) & 0xffff;
  }

  private raw32(addr: number): number {
    addr &= ~3;
    switch (addr >>> 24) {
      case 0x0: return this.readBios32(addr);
      case 0x2: return this.ewramMem.u32[(addr & 0x3ffff) >>> 2];
      case 0x3: return this.iwramMem.u32[(addr & 0x7fff) >>> 2];
      case 0x4: return (this.ioRead16(addr) | (this.ioRead16(addr + 2) << 16)) >>> 0;
      case 0x5: return this.palMem.u32[(addr & 0x3ff) >>> 2];
      case 0x6: return this.vramMem.u32[vramOffset(addr) >>> 2];
      case 0x7: return this.oamMem.u32[(addr & 0x3ff) >>> 2];
      case 0x8: case 0x9: case 0xa: case 0xb: case 0xc: case 0xd:
        return (this.romRead16(addr) | (this.romRead16(addr + 2) << 16)) >>> 0;
      case 0xe: case 0xf: return (this.save.read8(addr & 0xffff) * 0x01010101) >>> 0;
    }
    return this.openBus();
  }

  private romRead16(addr: number): number {
    const off = addr & 0x01fffffe;
    if (addr >= 0x0d000000 && this.save.isEeprom) return this.save.eepromRead();
    if (this.gpio.readable && off >= 0xc4 && off <= 0xc8) return this.gpio.read(off);
    if (off < this.romSize) return this.romMem.u16[off >>> 1];
    // Nothing drives the bus past the end of the ROM, so the low 16 address
    // lines (still latched on the shared AD bus) read back.
    return (off >>> 1) & 0xffff;
  }

  // ---- data accesses (charged) ---------------------------------------------

  read8(addr: number): number { this.cycles += this.n16[(addr >>> 24) & 0xf]; return this.raw8(addr); }
  read16(addr: number): number { this.cycles += this.n16[(addr >>> 24) & 0xf]; return this.raw16(addr); }
  read32(addr: number): number { this.cycles += this.n32[(addr >>> 24) & 0xf]; return this.raw32(addr); }

  write8(addr: number, value: number): void {
    this.cycles += this.n16[(addr >>> 24) & 0xf];
    this.rawWrite8(addr, value);
  }
  write16(addr: number, value: number): void {
    this.cycles += this.n16[(addr >>> 24) & 0xf];
    this.rawWrite16(addr, value);
  }
  write32(addr: number, value: number): void {
    this.cycles += this.n32[(addr >>> 24) & 0xf];
    this.rawWrite32(addr, value);
  }

  /** Sequential-cost variants for the 2nd+ access of a burst (DMA, LDM/STM). */
  read16Seq(addr: number): number { this.cycles += this.s16[(addr >>> 24) & 0xf]; return this.raw16(addr); }
  read32Seq(addr: number): number { this.cycles += this.s32[(addr >>> 24) & 0xf]; return this.raw32(addr); }
  write16Seq(addr: number, value: number): void { this.cycles += this.s16[(addr >>> 24) & 0xf]; this.rawWrite16(addr, value); }
  write32Seq(addr: number, value: number): void { this.cycles += this.s32[(addr >>> 24) & 0xf]; this.rawWrite32(addr, value); }

  // ---- opcode fetches (charged, sequential-aware) ---------------------------

  fetch16(addr: number): number {
    const region = (addr >>> 24) & 0xf;
    if (this.lastFetchEnd !== addr) this.cycles += this.n16[region];
    else this.cycles += this.prefetch && region >= 8 ? 1 : this.s16[region];
    this.lastFetchEnd = addr + 2;
    this.inBios = addr < 0x4000;
    return (this.lastFetched = this.raw16(addr));
  }

  fetch32(addr: number): number {
    const region = (addr >>> 24) & 0xf;
    if (this.lastFetchEnd !== addr) this.cycles += this.n32[region];
    else this.cycles += this.prefetch && region >= 8 ? 1 : this.s32[region];
    this.lastFetchEnd = addr + 4;
    this.inBios = addr < 0x4000;
    return (this.lastFetched = this.raw32(addr));
  }

  /** A data access or branch broke the sequential fetch stream. */
  breakSeq(): void {
    this.lastFetchEnd = -1;
  }

  // ---- writes ---------------------------------------------------------------

  private rawWrite8(addr: number, value: number): void {
    value &= 0xff;
    switch (addr >>> 24) {
      case 0x2: this.ewram[addr & 0x3ffff] = value; return;
      case 0x3:
        this.iwram[addr & 0x7fff] = value;
        if ((addr & 0x7ffe) === 0x7ff8) this.onIntrFlagsWritten();
        return;
      case 0x4: this.ioWrite8(addr, value); return;
      case 0x5: this.pal16[(addr & 0x3ff) >>> 1] = value * 0x0101; return;
      // Byte stores to the 16-bit video memories land as a doubled halfword.
      case 0x6: this.vramMem.u16[vramOffset(addr) >>> 1] = value * 0x0101; return;
      case 0x7: return; // OAM ignores byte writes
      case 0x8: case 0x9:
        this.gpioWrite(addr & ~1, value << ((addr & 1) * 8));
        return;
      case 0xe: case 0xf: this.save.write8(addr & 0xffff, value); return;
    }
  }

  private rawWrite16(addr: number, value: number): void {
    value &= 0xffff;
    switch (addr >>> 24) {
      case 0x2: this.ewramMem.u16[(addr & 0x3ffff) >>> 1] = value; return;
      case 0x3:
        this.iwramMem.u16[(addr & 0x7fff) >>> 1] = value;
        if ((addr & 0x7ffe) === 0x7ff8) this.onIntrFlagsWritten();
        return;
      case 0x4: this.ioWrite16(addr & ~1, value); return;
      case 0x5: this.pal16[(addr & 0x3ff) >>> 1] = value; return;
      case 0x6: this.vramMem.u16[vramOffset(addr) >>> 1] = value; return;
      case 0x7: this.oam16[(addr & 0x3ff) >>> 1] = value; return;
      case 0x8: case 0x9: this.gpioWrite(addr & ~1, value); return;
      case 0xd: if (this.save.isEeprom) this.save.eepromWrite(value); return;
      // The 8-bit save bus sees whichever byte lines up with the address.
      case 0xe: case 0xf:
        this.save.write8(addr & 0xffff, (value >>> ((addr & 1) * 8)) & 0xff);
        return;
    }
  }

  private rawWrite32(addr: number, value: number): void {
    switch (addr >>> 24) {
      case 0x2: this.ewramMem.u32[(addr & 0x3ffff) >>> 2] = value; return;
      case 0x3:
        this.iwramMem.u32[(addr & 0x7fff) >>> 2] = value;
        if ((addr & 0x7ffc) === 0x7ff8) this.onIntrFlagsWritten();
        return;
      case 0x4:
        addr &= ~3;
        this.ioWrite16(addr, value & 0xffff);
        this.ioWrite16(addr + 2, value >>> 16);
        return;
      case 0x5: this.palMem.u32[(addr & 0x3ff) >>> 2] = value; return;
      case 0x6: this.vramMem.u32[vramOffset(addr) >>> 2] = value; return;
      case 0x7: this.oamMem.u32[(addr & 0x3ff) >>> 2] = value; return;
      case 0x8: case 0x9:
        addr &= ~3;
        this.gpioWrite(addr, value & 0xffff);
        this.gpioWrite(addr + 2, value >>> 16);
        return;
      case 0xd: if (this.save.isEeprom) this.save.eepromWrite(value & 0xffff); return;
      case 0xe: case 0xf:
        this.save.write8(addr & 0xffff, (value >>> ((addr & 3) * 8)) & 0xff);
        return;
    }
  }

  private gpioWrite(addr: number, value: number): void {
    const off = addr & 0x01fffffe;
    if (off >= 0xc4 && off <= 0xc8) this.gpio.write(off, value & 0xffff);
  }

  /** Uncharged access for HLE BIOS routines and tooling. */
  peek8(addr: number): number { return this.raw8(addr); }
  peek16(addr: number): number { return this.raw16(addr); }
  peek32(addr: number): number { return this.raw32(addr); }
  poke8(addr: number, v: number): void {
    // HLE decompressors emit true bytes, which a CPU byte store to video
    // memory would not be.
    switch (addr >>> 24) {
      case 0x5: this.pal[addr & 0x3ff] = v; return;
      case 0x6: this.vram[vramOffset(addr)] = v; return;
      case 0x7: this.oam[addr & 0x3ff] = v; return;
      default: this.rawWrite8(addr, v);
    }
  }
  poke16(addr: number, v: number): void { this.rawWrite16(addr, v); }
  poke32(addr: number, v: number): void { this.rawWrite32(addr, v); }

  // ---- IO dispatch -----------------------------------------------------------
  // PPU and System registers are halfword-oriented; the APU block is
  // byte-oriented like its Game Boy ancestor.

  /** Returns -1 for write-only / unmapped registers. */
  private ioReadRaw(off: number): number {
    if (off < 0x60) return this.ppu.ioRead(off);
    if (off < 0xb0) return this.apu.ioRead8(off) | (this.apu.ioRead8(off + 1) << 8);
    if (off < 0x400) {
      if (off >= 0x100 && off < 0x110) this.ioSync(); // live timer counters
      return this.sys.ioRead(off);
    }
    // 0x800 (undocumented internal memory control) mirrors every 64K.
    return -1;
  }

  private ioRead16(addr: number): number {
    if ((addr & 0x00fffc00) !== 0) return this.openBus() & 0xffff;
    const v = this.ioReadRaw(addr & 0x3fe);
    return v < 0 ? 0 : v & 0xffff;
  }

  private ioWrite16(addr: number, value: number): void {
    if ((addr & 0x00fffc00) !== 0) return;
    const off = addr & 0x3fe;
    this.ioSync();
    this.ioShadow[off >>> 1] = value;
    if (off < 0x60) this.ppu.ioWrite(off, value);
    else if (off < 0xb0) {
      this.apu.ioWrite8(off, value & 0xff);
      this.apu.ioWrite8(off + 1, value >>> 8);
    } else this.sys.ioWrite(off, value);
  }

  private ioWrite8(addr: number, value: number): void {
    if ((addr & 0x00fffc00) !== 0) return;
    const off = addr & 0x3ff;
    if (off >= 0x60 && off < 0xb0) {
      this.ioSync();
      this.apu.ioWrite8(off, value);
      return;
    }
    const even = off & 0x3fe;
    const shift = (off & 1) * 8;
    // Registers where the untouched byte must not be rewritten: IF is
    // write-1-to-clear, and POSTFLG/HALTCNT share a halfword.
    if (even === 0x202 || even === 0x300) {
      this.ioSync();
      this.sys.ioWrite8(off, value);
      return;
    }
    // Widen using the current readable value, or the last write for
    // write-only registers (timer reload reads back as the counter).
    const isTimerReload = even >= 0x100 && even < 0x110 && (even & 2) === 0;
    const readable = isTimerReload ? -1 : this.ioReadRaw(even);
    const base = readable >= 0 ? readable : this.ioShadow[even >>> 1];
    this.ioWrite16(even, (base & ~(0xff << shift)) | (value << shift));
  }

  // ---- save states -----------------------------------------------------------

  saveState(w: StateWriter): void {
    w.bytes(this.ewram); w.bytes(this.iwram); w.bytes(this.pal);
    w.bytes(this.vram); w.bytes(this.oam);
    w.bytes(new Uint8Array(this.ioShadow.buffer));
    w.u32(this.lastFetched); w.u32(this.biosLatch);
  }

  loadState(r: StateReader): void {
    r.bytesInto(this.ewram); r.bytesInto(this.iwram); r.bytesInto(this.pal);
    r.bytesInto(this.vram); r.bytesInto(this.oam);
    r.bytesInto(new Uint8Array(this.ioShadow.buffer));
    this.lastFetched = r.u32(); this.biosLatch = r.u32();
    this.lastFetchEnd = -1;
  }
}

/** VRAM is 96K mirrored in 128K steps; the top 32K repeats the OBJ area. */
function vramOffset(addr: number): number {
  const off = addr & 0x1ffff;
  return off >= 0x18000 ? off - 0x8000 : off;
}
