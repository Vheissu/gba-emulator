// Cartridge save hardware: SRAM, Flash (64K/128K), EEPROM (512B/8K).
// Detection is by the version strings the SDK save libraries embed in the
// ROM image.

import type { StateReader, StateWriter } from "./state";

export type SaveKind = "none" | "sram" | "flash64" | "flash128" | "eeprom";

const MARKERS: [string, SaveKind][] = [
  ["EEPROM_V", "eeprom"],
  ["FLASH1M_V", "flash128"],
  ["FLASH512_V", "flash64"],
  ["FLASH_V", "flash64"],
  ["SRAM_V", "sram"],
  ["SRAM_F_V", "sram"],
];

export function detectSaveKind(rom: Uint8Array): SaveKind {
  // Library strings are word-aligned; pre-filter on the first letter.
  for (let i = 0; i + 12 < rom.length; i += 4) {
    const c = rom[i];
    if (c !== 0x45 && c !== 0x46 && c !== 0x53) continue;
    for (const [marker, kind] of MARKERS) {
      let match = true;
      for (let j = 0; j < marker.length && match; j++) {
        match = rom[i + j] === marker.charCodeAt(j);
      }
      if (match) return kind;
    }
  }
  return "none";
}

export abstract class SaveDevice {
  abstract readonly kind: SaveKind;
  abstract data: Uint8Array;
  /** Set whenever the backing memory changes; cleared by whoever persists it. */
  dirty = false;

  get isEeprom(): boolean { return false; }
  /** Number of bytes worth persisting. */
  get size(): number { return this.data.length; }

  read8(_addr: number): number { return 0xff; }
  write8(_addr: number, _value: number): void {}
  eepromRead(): number { return 1; }
  eepromWrite(_value: number): void {}
  /** DMA3 word count of a transfer aimed at the EEPROM; reveals its size. */
  eepromDmaHint(_count: number): void {}

  /** Battery-backed contents, for persisting to disk. */
  serialize(): Uint8Array { return this.data.slice(0, this.size); }
  deserialize(d: Uint8Array): void {
    this.data.set(d.subarray(0, this.data.length));
    this.dirty = false;
  }

  saveState(w: StateWriter): void { w.blob(this.data); }
  loadState(r: StateReader): void {
    this.data.set(r.blob().subarray(0, this.data.length));
    this.dirty = true;
  }
}

class NoneSave extends SaveDevice {
  readonly kind = "none";
  data = new Uint8Array(0);
}

class SramSave extends SaveDevice {
  readonly kind = "sram";
  data = new Uint8Array(0x8000).fill(0xff);
  read8(addr: number): number { return this.data[addr & 0x7fff]; }
  write8(addr: number, value: number): void {
    this.data[addr & 0x7fff] = value;
    this.dirty = true;
  }
}

const enum FlashCmd { Idle, Unlock1, Unlock2 }

class FlashSave extends SaveDevice {
  readonly kind: SaveKind;
  data: Uint8Array;

  private cmd = FlashCmd.Idle;
  private idMode = false;
  private erasePending = false;
  private writePending = false;
  private bankPending = false;
  private bank = 0;

  constructor(private large: boolean) {
    super();
    this.kind = large ? "flash128" : "flash64";
    this.data = new Uint8Array(large ? 0x20000 : 0x10000).fill(0xff);
  }

  read8(addr: number): number {
    if (this.idMode && addr < 2) {
      // Macronix MX29L010 (128K) / Panasonic MN63F805MNP (64K)
      if (this.large) return addr === 0 ? 0xc2 : 0x09;
      return addr === 0 ? 0x32 : 0x1b;
    }
    return this.data[this.bank + addr];
  }

  write8(addr: number, value: number): void {
    if (this.writePending) {
      this.writePending = false;
      this.data[this.bank + addr] = value;
      this.dirty = true;
      return;
    }
    if (this.bankPending) {
      this.bankPending = false;
      if (addr === 0 && this.large) this.bank = (value & 1) << 16;
      return;
    }
    switch (this.cmd) {
      case FlashCmd.Idle:
        if (addr === 0x5555 && value === 0xaa) this.cmd = FlashCmd.Unlock1;
        else if (value === 0xf0) this.idMode = false;
        return;
      case FlashCmd.Unlock1:
        this.cmd = addr === 0x2aaa && value === 0x55 ? FlashCmd.Unlock2 : FlashCmd.Idle;
        return;
      case FlashCmd.Unlock2:
        this.cmd = FlashCmd.Idle;
        this.command(addr, value);
        return;
    }
  }

  private command(addr: number, value: number): void {
    if (this.erasePending) {
      this.erasePending = false;
      if (value === 0x10 && addr === 0x5555) {
        this.data.fill(0xff);
        this.dirty = true;
      } else if (value === 0x30) {
        const base = this.bank + (addr & 0xf000);
        this.data.fill(0xff, base, base + 0x1000);
        this.dirty = true;
      }
      return;
    }
    if (addr !== 0x5555) return;
    switch (value) {
      case 0x90: this.idMode = true; return;
      case 0xf0: this.idMode = false; return;
      case 0x80: this.erasePending = true; return;
      case 0xa0: this.writePending = true; return;
      case 0xb0: this.bankPending = true; return;
    }
  }

  saveState(w: StateWriter): void {
    super.saveState(w);
    w.u8(this.cmd); w.bool(this.idMode); w.bool(this.erasePending);
    w.bool(this.writePending); w.bool(this.bankPending); w.u32(this.bank);
  }

  loadState(r: StateReader): void {
    super.loadState(r);
    this.cmd = r.u8(); this.idMode = r.bool(); this.erasePending = r.bool();
    this.writePending = r.bool(); this.bankPending = r.bool(); this.bank = r.u32();
  }
}

/** Serial EEPROM. Commands are bit streams clocked in through DMA3:
 *    read:  1 1 <addr> 0            then 4 dummy bits + 64 data bits out
 *    write: 1 0 <addr> <64 data> 0  then "ready" (1) out
 *  The address is 6 bits on the 512-byte part and 14 on the 8K part. */
class EepromSave extends SaveDevice {
  readonly kind = "eeprom";
  data = new Uint8Array(0x2000).fill(0xff);

  private addrBits = 14;
  private sizeKnown = false;
  private inBits = new Uint8Array(2 + 14 + 64 + 1);
  private inCount = 0;
  private outBits = new Uint8Array(68);
  private outPos = 68;

  get isEeprom(): boolean { return true; }
  get size(): number { return this.addrBits === 6 ? 0x200 : 0x2000; }

  eepromDmaHint(count: number): void {
    if (this.sizeKnown) return;
    if (count === 9 || count === 73) this.addrBits = 6;
    else if (count === 17 || count === 81) this.addrBits = 14;
    else return;
    this.sizeKnown = true;
  }

  deserialize(d: Uint8Array): void {
    super.deserialize(d);
    // A stored save tells us the chip size before the game does.
    if (d.length === 0x200 || d.length === 0x2000) {
      this.addrBits = d.length === 0x200 ? 6 : 14;
      this.sizeKnown = true;
    }
  }

  eepromRead(): number {
    return this.outPos < this.outBits.length ? this.outBits[this.outPos++] : 1;
  }

  eepromWrite(value: number): void {
    const bits = this.inBits;
    if (this.inCount === 0 && !(value & 1)) return; // commands start with a 1
    bits[this.inCount++] = value & 1;
    if (this.inCount < 2) return;
    const header = 2 + this.addrBits;
    if (bits[1]) {
      if (this.inCount === header + 1) { this.beginRead(); this.inCount = 0; }
    } else if (this.inCount === header + 65) {
      this.commitWrite();
      this.inCount = 0;
    }
  }

  private blockOffset(): number {
    let addr = 0;
    for (let i = 0; i < this.addrBits; i++) addr = (addr << 1) | this.inBits[2 + i];
    return (addr & 0x3ff) * 8;
  }

  private beginRead(): void {
    const off = this.blockOffset();
    this.outBits.fill(0, 0, 4);
    for (let i = 0; i < 64; i++) {
      this.outBits[4 + i] = (this.data[off + (i >> 3)] >> (7 - (i & 7))) & 1;
    }
    this.outPos = 0;
  }

  private commitWrite(): void {
    const off = this.blockOffset();
    const first = 2 + this.addrBits;
    for (let i = 0; i < 8; i++) {
      let b = 0;
      for (let bit = 0; bit < 8; bit++) b = (b << 1) | this.inBits[first + i * 8 + bit];
      this.data[off + i] = b;
    }
    this.outPos = this.outBits.length; // reads now return "ready"
    this.dirty = true;
  }

  saveState(w: StateWriter): void {
    super.saveState(w);
    w.u8(this.addrBits); w.bool(this.sizeKnown);
    w.bytes(this.inBits); w.u8(this.inCount);
    w.bytes(this.outBits); w.u8(this.outPos);
  }

  loadState(r: StateReader): void {
    super.loadState(r);
    this.addrBits = r.u8(); this.sizeKnown = r.bool();
    r.bytesInto(this.inBits); this.inCount = r.u8();
    r.bytesInto(this.outBits); this.outPos = r.u8();
  }
}

export function createSave(kind: SaveKind): SaveDevice {
  switch (kind) {
    case "sram": return new SramSave();
    case "flash64": return new FlashSave(false);
    case "flash128": return new FlashSave(true);
    case "eeprom": return new EepromSave();
    default: return new NoneSave();
  }
}
