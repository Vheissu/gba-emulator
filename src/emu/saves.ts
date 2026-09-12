// Cartridge save hardware: SRAM, FLASH (64K/128K), EEPROM (512B/8K).
// Detection is by version strings embedded in the ROM image, same scheme
// the real SDK libraries use.

export type SaveKind = "none" | "sram" | "flash64" | "flash128" | "eeprom";

export function detectSaveKind(rom: Uint8Array): SaveKind {
  // Scan for SDK save-library markers.
  const len = Math.min(rom.length, 0x2000000);
  let found: SaveKind = "none";
  for (let i = 0; i + 12 < len; i += 4) {
    // cheap pre-check on 'E','F','S'
    const c = rom[i];
    if (c !== 0x45 && c !== 0x46 && c !== 0x53) continue;
    const s = String.fromCharCode(
      rom[i], rom[i + 1], rom[i + 2], rom[i + 3], rom[i + 4],
      rom[i + 5], rom[i + 6], rom[i + 7], rom[i + 8],
    );
    if (s.startsWith("EEPROM_V")) return "eeprom";
    if (s.startsWith("FLASH1M_V")) return "flash128";
    if (s.startsWith("FLASH512_V") || s.startsWith("FLASH_V")) found = "flash64";
    else if (s.startsWith("SRAM_V")) found = "sram";
  }
  return found;
}

export interface SaveDevice {
  kind: SaveKind;
  size: number;
  data: Uint8Array;
  read8(addr: number): number;
  write8(addr: number, value: number): void;
  // EEPROM bit-level interface
  eepromRead(): number;
  eepromWrite(value: number): void;
  eepromAt(addr: number): boolean;
  serialize(): Uint8Array;
  deserialize(data: Uint8Array): void;
}

class NoneSave implements SaveDevice {
  kind: SaveKind = "none";
  size = 0;
  data = new Uint8Array(0);
  read8(): number { return 0xff; }
  write8(): void {}
  eepromRead(): number { return 1; }
  eepromWrite(): void {}
  eepromAt(): boolean { return false; }
  serialize(): Uint8Array { return this.data; }
  deserialize(): void {}
}

export class SRAMSave implements SaveDevice {
  kind: SaveKind = "sram";
  size = 0x8000;
  data = new Uint8Array(this.size).fill(0xff);
  read8(addr: number): number { return this.data[addr & 0x7fff]; }
  write8(addr: number, value: number): void { this.data[addr & 0x7fff] = value & 0xff; }
  eepromRead(): number { return 1; }
  eepromWrite(): void {}
  eepromAt(): boolean { return false; }
  serialize(): Uint8Array { return this.data; }
  deserialize(d: Uint8Array): void { this.data.set(d.subarray(0, this.size)); }
}

export class FlashSave implements SaveDevice {
  kind: SaveKind;
  size: number;
  data: Uint8Array;

  private idMode = false;
  private bank = 0;
  private cmdState = 0; // 0 idle, 1 saw AA@5555, 2 saw 55@2AAA
  private eraseArm = false;
  private writeArm = false;
  private bankArm = false;

  constructor(kb: 64 | 128) {
    this.kind = kb === 128 ? "flash128" : "flash64";
    this.size = kb * 1024;
    this.data = new Uint8Array(this.size).fill(0xff);
  }

  read8(addr: number): number {
    addr &= 0xffff;
    if (this.idMode) {
      // Macronix IDs: 64K -> MX29LV512-ish (C2/BF... commonly 32/1B for 512K)
      if (addr === 0) return this.size === 0x20000 ? 0xc2 : 0x32;
      if (addr === 1) return this.size === 0x20000 ? 0x09 : 0x1b;
      return 0;
    }
    return this.data[this.bank * 0x10000 + addr];
  }

  write8(addr: number, value: number): void {
    addr &= 0xffff;
    value &= 0xff;
    if (this.writeArm) {
      this.writeArm = false;
      this.data[this.bank * 0x10000 + addr] = value;
      return;
    }
    if (this.bankArm) {
      this.bankArm = false;
      if (addr === 0 && this.size === 0x20000) this.bank = value & 1;
      return;
    }
    if (this.eraseArm) {
      this.eraseArm = false;
      if (value === 0x30) {
        // Sector erase: 4KB sector containing addr (or chip at 5555).
        if (addr === 0x5555) {
          this.data.fill(0xff);
        } else {
          const base = (this.bank * 0x10000 + addr) & ~0xfff;
          this.data.fill(0xff, base, base + 0x1000);
        }
      }
      return;
    }
    switch (this.cmdState) {
      case 0:
        if (addr === 0x5555 && value === 0xaa) this.cmdState = 1;
        return;
      case 1:
        if (addr === 0x2aaa && value === 0x55) this.cmdState = 2;
        else this.cmdState = 0;
        return;
      case 2:
        this.cmdState = 0;
        if (addr === 0x5555) {
          switch (value) {
            case 0x90: this.idMode = true; return;
            case 0xf0: this.idMode = false; return;
            case 0x80: this.eraseArm = true; this.cmdState = 1; return; // needs AA/55/30 next
            case 0xa0: this.writeArm = true; return;
            case 0xb0: this.bankArm = true; return;
          }
        } else if (value === 0xf0) {
          this.idMode = false;
        }
        return;
    }
  }

  eepromRead(): number { return 1; }
  eepromWrite(): void {}
  eepromAt(): boolean { return false; }
  serialize(): Uint8Array { return this.data; }
  deserialize(d: Uint8Array): void { this.data.set(d.subarray(0, this.size)); }
}

export class EepromSave implements SaveDevice {
  kind: SaveKind = "eeprom";
  size: number;
  data: Uint8Array;

  // Serial protocol state
  private bits: number[] = [];
  private state: "idle" | "read" | "written" = "idle";
  private readQueue: number[] = [];
  private addrBits = -1; // unknown until first command completes
  

  constructor(large: boolean) {
    this.size = large ? 8192 : 512;
    this.data = new Uint8Array(this.size).fill(0xff);
    this.addrBits = large ? 14 : 6;
  }

  read8(): number { return 0xff; }
  write8(): void {}

  eepromAt(addr: number): boolean {
    return (addr & 0x0f000000) === 0x0d000000;
  }

  eepromWrite(value: number): void {
    this.bits.push(value & 1);
    // WRITE command completes when we have 2 + addrBits + 64 bits.
    const need = 2 + this.addrBits + 64;
    if (this.bits.length >= 2) {
      const op = (this.bits[0] << 1) | this.bits[1];
      if (op === 0b10 && this.bits.length === need) {
        this.commitWrite();
      } else if (op === 0b11 && this.bits.length === 2 + this.addrBits) {
        this.commitRead();
      } else if (this.bits.length > need + 8) {
        // Stream desynced; reset.
        this.bits = [];
      }
    }
  }

  eepromRead(): number {
    if (this.state === "read") {
      return this.readQueue.length ? this.readQueue.shift()! : 1;
    }
    if (this.state === "written") {
      this.state = "idle";
      return 1; // write finished
    }
    // A read with a pending command stream: try to complete it.
    if (this.bits.length >= 2) {
      const op = (this.bits[0] << 1) | this.bits[1];
      const avail = this.bits.length - 2;
      if (op === 0b11) {
        // READ: infer address width from the bit count if unknown.
        if (avail === 6 || avail === 14) {
          this.addrBits = avail;
          this.commitRead();
          return this.readQueue.length ? this.readQueue.shift()! : 1;
        }
        if (avail === 2 + this.addrBits - 2) {
          this.commitRead();
          return this.readQueue.length ? this.readQueue.shift()! : 1;
        }
        // Unknown / partial -> guess by size
        this.commitRead();
        return this.readQueue.length ? this.readQueue.shift()! : 1;
      }
      if (op === 0b10) {
        // WRITE terminated early by a read -> try both address widths.
        if (avail === 6 + 64) { this.addrBits = 6; this.commitWrite(); }
        else if (avail === 14 + 64) { this.addrBits = 14; this.commitWrite(); }
        this.state = "written";
        this.bits = [];
        return 1;
      }
    }
    this.bits = [];
    return 1;
  }

  private commitRead(): void {
    const aBits = this.bits.length - 2;
    let addr = 0;
    for (let i = 0; i < aBits; i++) addr = (addr << 1) | this.bits[2 + i];
    addr &= (this.data.length / 8) - 1;
    this.readQueue = [0, 0, 0, 0];
    for (let i = 7; i >= 0; i--) {
      const b = this.data[addr * 8 + (7 - i)];
      for (let bit = 7; bit >= 0; bit--) this.readQueue.push((b >>> bit) & 1);
    }
    this.state = "read";
    this.bits = [];
  }

  private commitWrite(): void {
    const aBits = this.bits.length - 2 - 64;
    if (aBits !== 6 && aBits !== 14) { this.bits = []; return; }
    let addr = 0;
    for (let i = 0; i < aBits; i++) addr = (addr << 1) | this.bits[2 + i];
    addr &= (this.data.length / 8) - 1;
    const off = 2 + aBits;
    for (let i = 0; i < 8; i++) {
      let b = 0;
      for (let bit = 0; bit < 8; bit++) b = (b << 1) | this.bits[off + i * 8 + bit];
      this.data[addr * 8 + i] = b;
    }
    this.state = "written";
    this.bits = [];
  }

  serialize(): Uint8Array { return this.data; }
  deserialize(d: Uint8Array): void { this.data.set(d.subarray(0, this.size)); }
}

export function createSave(kind: SaveKind, romSize: number): SaveDevice {
  switch (kind) {
    case "sram": return new SRAMSave();
    case "flash64": return new FlashSave(64);
    case "flash128": return new FlashSave(128);
    case "eeprom": return new EepromSave(romSize > 16 * 1024 * 1024);
    default: return new NoneSave();
  }
}
