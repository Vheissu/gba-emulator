// Memory bus: address decode, waitstates, IO dispatch.
// GBA memory map (address bits 27..24 select the region):
//   0x0 BIOS (16K)   0x2 EWRAM (256K)  0x3 IWRAM (32K)  0x4 IO
//   0x5 PAL (1K)     0x6 VRAM (96K)    0x7 OAM (1K)
//   0x8-0xD ROM (up to 32M, WS0/WS1/WS2 + SRAM window)

export interface BusDevice {
  ioRead(addr: number): number; // return -1 for "not mine"
  ioWrite(addr: number, value: number): void;
}

// Waitstates (cycles) for a 16-bit access, indexed [region][nonseq?0:1].
const WS16: number[][] = [
  [1, 1], // 0 BIOS
  [1, 1], // 1
  [3, 3], // 2 EWRAM (2 wait)
  [1, 1], // 3 IWRAM
  [1, 1], // 4 IO
  [1, 1], // 5 PAL
  [1, 1], // 6 VRAM
  [1, 1], // 7 OAM
  [4, 2], // 8 ROM WS0  (post-boot defaults: N=4 S=2)
  [4, 2], // 9
  [4, 2], // a ROM WS1
  [4, 2], // b
  [4, 2], // c ROM WS2
  [4, 2], // d
  [4, 4], // e SRAM
  [4, 4], // f
];

export class Bus {
  bios: Uint8Array | null = null;
  ewram = new Uint8Array(256 * 1024);
  iwram = new Uint8Array(32 * 1024);
  pal = new Uint8Array(1024);
  vram = new Uint8Array(96 * 1024);
  oam = new Uint8Array(1024);
  rom: Uint8Array = new Uint8Array(0);
  romMask = 0;

  ioFallback = new Uint8Array(0x800);
  devices: BusDevice[] = [];
  addCycles: (n: number) => void = () => {};

  /** Fired when the BIOS interrupt-flag mirror (0x03007FF8) is written —
   *  e.g. by the IRQ shim. Lets the HLE IntrWait consume flags at the same
   *  point the real BIOS loop would see them. */
  onIntrFlagsWritten: () => void = () => {};

  // Save hardware hooks (installed by save.ts).
  sramRead: (addr: number) => number = () => 0xff;
  sramWrite: (addr: number, value: number) => void = () => {};
  eepromRead: () => number = () => 1;
  eepromWrite: (value: number) => void = () => {};
  eepromAt: (addr: number) => boolean = () => false;

  lastFetched = 0;

  loadRom(data: Uint8Array): void {
    let rom = data;
    if (rom.length === 0 || (rom.length & (rom.length - 1)) !== 0) {
      let size = 1;
      while (size < data.length) size <<= 1;
      const padded = new Uint8Array(size);
      padded.set(data);
      rom = padded;
    }
    this.rom = rom;
    this.romMask = rom.length - 1;
  }

  private romOffset(addr: number): number {
    return addr & 0x01ffffff & this.romMask;
  }

  // ---- cycle accounting ---------------------------------------------------

  private charge(addr: number, width32: boolean, seq: boolean): void {
    const w = WS16[(addr >>> 24) & 0xf];
    this.addCycles(width32 ? w[0] + w[1] : w[seq ? 1 : 0]);
  }

  internal(n = 1): void {
    this.addCycles(n);
  }

  // ---- raw (uncharged) reads ----------------------------------------------

  private raw8(addr: number): number {
    switch ((addr >>> 24) & 0xf) {
      case 0x0:
        if (addr < 0x4000 && this.bios) return this.bios[addr];
        return (this.lastFetched >>> ((addr & 3) * 8)) & 0xff;
      case 0x2: return this.ewram[addr & 0x3ffff];
      case 0x3: return this.iwram[addr & 0x7fff];
      case 0x4: return this.ioRead8(addr & 0x7ff);
      case 0x5: return this.pal[addr & 0x3ff];
      case 0x6: return this.vram[this.vramOffset(addr)];
      case 0x7: return this.oam[addr & 0x3ff];
      case 0x8: case 0x9: case 0xa: case 0xb: case 0xc: case 0xd:
        if (this.eepromAt(addr)) return this.eepromRead();
        return this.rom[this.romOffset(addr)];
      case 0xe: case 0xf: return this.sramRead(addr & 0xffff);
    }
    return 0;
  }

  private raw16(addr: number): number {
    addr &= ~1;
    const r = (addr >>> 24) & 0xf;
    if (r === 0x4) return this.ioRead16(addr & 0x7ff);
    if (r === 0xe || r === 0xf) return this.sramRead(addr & 0xffff) * 0x0101;
    if (r >= 0x8 && this.eepromAt(addr)) return this.eepromRead();
    return this.raw8(addr) | (this.raw8(addr + 1) << 8);
  }

  private raw32(addr: number): number {
    addr &= ~3;
    const r = (addr >>> 24) & 0xf;
    if (r === 0x4) {
      return (this.ioRead16(addr & 0x7ff) | (this.ioRead16((addr & 0x7ff) + 2) << 16)) >>> 0;
    }
    if (r === 0xe || r === 0xf) return this.sramRead(addr & 0xffff) * 0x01010101;
    return (this.raw16(addr) | (this.raw16(addr + 2) << 16)) >>> 0;
  }

  // ---- public data accesses (charged) --------------------------------------

  read8(addr: number): number { this.charge(addr, false, false); return this.raw8(addr); }
  read16(addr: number): number { this.charge(addr, false, false); return this.raw16(addr); }
  read32(addr: number): number { this.charge(addr, true, false); return this.raw32(addr); }

  /** Sequential-charge variant used by DMA bursts. */
  read16Seq(addr: number): number { this.charge(addr, false, true); return this.raw16(addr); }
  read32Seq(addr: number): number { this.charge(addr, false, true); this.charge(addr, false, true); return this.raw32(addr); }
  write16Seq(addr: number, v: number): void { this.charge(addr, false, true); this.rawWrite16(addr, v); }
  write32Seq(addr: number, v: number): void { this.charge(addr, false, true); this.charge(addr, false, true); this.rawWrite32(addr, v); }

  // ---- fetches (charged, track sequential prefetch) ------------------------

  private lastFetchEnd = -1;

  fetch16(addr: number): number {
    const seq = this.lastFetchEnd === addr;
    this.charge(addr, false, seq);
    this.lastFetchEnd = addr + 2;
    const v = this.raw16(addr & ~1);
    this.lastFetched = v;
    return v;
  }

  fetch32(addr: number): number {
    const seq = this.lastFetchEnd === addr;
    const w = WS16[(addr >>> 24) & 0xf];
    this.addCycles(seq ? w[1] + w[1] : w[0] + w[1]);
    this.lastFetchEnd = addr + 4;
    const v = this.raw32(addr & ~3);
    this.lastFetched = v;
    return v;
  }

  breakSeq(): void {
    this.lastFetchEnd = -1;
  }

  // ---- writes ---------------------------------------------------------------

  private rawWrite8(addr: number, value: number): void {
    value &= 0xff;
    switch ((addr >>> 24) & 0xf) {
      case 0x2: this.ewram[addr & 0x3ffff] = value; return;
      case 0x3:
        this.iwram[addr & 0x7fff] = value;
        if ((addr & 0x7ffe) === 0x7ff8) this.onIntrFlagsWritten();
        return;
      case 0x4: this.ioWrite8(addr & 0x7ff, value); return;
      case 0x5: {
        const o = addr & 0x3fe;
        this.pal[o] = value;
        this.pal[o + 1] = value;
        return;
      }
      case 0x6: {
        const o = this.vramOffset(addr) & ~1;
        this.vram[o] = value;
        this.vram[o + 1] = value;
        return;
      }
      case 0x7: return; // OAM ignores byte writes
      case 0xe: case 0xf: this.sramWrite(addr & 0xffff, value); return;
      default: return;
    }
  }

  private rawWrite16(addr: number, value: number): void {
    addr &= ~1;
    value &= 0xffff;
    const r = (addr >>> 24) & 0xf;
    if (r === 0x4) { this.ioWrite16(addr & 0x7ff, value); return; }
    if (r === 0xe || r === 0xf) { this.sramWrite(addr & 0xffff, value & 0xff); return; }
    if (r >= 0x8 && this.eepromAt(addr)) { this.eepromWrite(value); return; }
    if (r === 0x7) {
      const o = addr & 0x3fe;
      this.oam[o] = value & 0xff;
      this.oam[o + 1] = value >>> 8;
      return;
    }
    if (r === 0x5) {
      const o = addr & 0x3fe;
      this.pal[o] = value & 0xff;
      this.pal[o + 1] = value >>> 8;
      return;
    }
    if (r === 0x6) {
      const o = this.vramOffset(addr);
      this.vram[o] = value & 0xff;
      this.vram[o + 1] = value >>> 8;
      return;
    }
    this.rawWrite8(addr, value & 0xff);
    this.rawWrite8(addr + 1, value >>> 8);
  }

  private rawWrite32(addr: number, value: number): void {
    addr &= ~3;
    const r = (addr >>> 24) & 0xf;
    if (r === 0x4) {
      this.ioWrite16(addr & 0x7ff, value & 0xffff);
      this.ioWrite16((addr & 0x7ff) + 2, value >>> 16);
      return;
    }
    if (r === 0x7) {
      const o = addr & 0x3fc;
      this.oam[o] = value & 0xff;
      this.oam[o + 1] = (value >>> 8) & 0xff;
      this.oam[o + 2] = (value >>> 16) & 0xff;
      this.oam[o + 3] = value >>> 24;
      return;
    }
    this.rawWrite16(addr, value & 0xffff);
    this.rawWrite16(addr + 2, value >>> 16);
  }

  write8(addr: number, value: number): void {
    this.charge(addr, false, false);
    this.rawWrite8(addr, value);
  }
  write16(addr: number, value: number): void {
    this.charge(addr, false, false);
    this.rawWrite16(addr, value);
  }
  write32(addr: number, value: number): void {
    this.charge(addr, true, false);
    this.rawWrite32(addr, value);
  }

  /** DMA reads (charged). */
  rawRead16ForDma(addr: number): number { this.charge(addr, false, false); return this.raw16(addr); }
  rawRead32ForDma(addr: number): number { this.charge(addr, true, false); return this.raw32(addr); }

  /** Uncharged access for the PPU / save-state / debugger paths. */
  peek16(addr: number): number { return this.raw16(addr); }
  peek32(addr: number): number { return this.raw32(addr); }
  poke16(addr: number, v: number): void { this.rawWrite16(addr, v); }
  poke32(addr: number, v: number): void { this.rawWrite32(addr, v); }

  // ---- VRAM mirroring --------------------------------------------------------
  vramOffset(addr: number): number {
    let off = addr & 0x1ffff;
    if (off >= 0x18000) off -= 0x8000;
    return off;
  }

  // ---- IO dispatch -----------------------------------------------------------

  private ioRead8(offset: number): number {
    const off = offset & 0x7ff;
    for (const d of this.devices) {
      const v = d.ioRead(off);
      if (v >= 0) return v & 0xff;
    }
    return this.ioFallback[off];
  }

  private ioRead16(offset: number): number {
    const off = offset & 0x7fe;
    for (const d of this.devices) {
      const v = d.ioRead(off);
      if (v >= 0) return v & 0xffff;
    }
    return this.ioFallback[off] | (this.ioFallback[off + 1] << 8);
  }

  private ioWrite8(offset: number, value: number): void {
    const off = offset & 0x7ff;
    this.ioFallback[off] = value & 0xff;
    for (const d of this.devices) d.ioWrite(off, value & 0xff);
  }

  private ioWrite16(offset: number, value: number): void {
    const off = offset & 0x7fe;
    this.ioFallback[off] = value & 0xff;
    this.ioFallback[off + 1] = (value >>> 8) & 0xff;
    for (const d of this.devices) d.ioWrite(off, value & 0xffff);
  }
}
