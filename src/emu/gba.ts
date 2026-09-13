// The GBA machine: wires CPU + bus + PPU + APU + system IO + saves + BIOS.

import { Bus } from "./bus";
import { CPU } from "./cpu";
import { PPU } from "./ppu";
import { APU } from "./apu";
import { System } from "./system";
import { BiosHLE, buildSyntheticBios } from "./bios";
import { SaveDevice, SaveKind, createSave, detectSaveKind } from "./saves";

export const CYCLES_PER_FRAME = 280896;

export interface RomInfo {
  title: string;
  code: string;
  maker: string;
  saveKind: SaveKind;
}

export class GBA {
  bus = new Bus();
  cpu = new CPU();
  ppu = new PPU();
  apu = new APU();
  sys = new System();
  biosHle = new BiosHLE();

  save: SaveDevice = createSave("none", 0);
  romInfo: RomInfo | null = null;

  cycles = 0;
  frameDone = false;
  /** Emulation speed multiplier (1 = normal). */
  speed = 1;

  constructor() {
    this.cpu.bus = this.bus;
    this.sys.bus = this.bus;
    this.sys.cpu = this.cpu;
    this.sys.apu = this.apu;
    this.ppu.vram = this.bus.vram;
    this.ppu.pal = this.bus.pal;
    this.ppu.oam = this.bus.oam;
    this.biosHle.cpu = this.cpu;
    this.biosHle.bus = this.bus;
    this.biosHle.sys = this.sys;

    this.bus.devices = [this.sys, this.ppu, this.apu];
    this.bus.addCycles = (n) => { this.cycles += n; };

    this.cpu.irqLine = () => this.sys.irqLine();
    this.cpu.haltWake = () => this.sys.haltWake();
    this.cpu.swiHandler = (n) => this.biosHle.swi(n);

    this.ppu.requestIrq = (bit) => this.sys.requestIrq(bit);
    this.sys.onIrqFired = () => this.biosHle.checkIntrWait();
    this.bus.onIntrFlagsWritten = () => this.biosHle.checkIntrWait();
    this.ppu.onVBlank = () => {
      this.sys.dmaTrigger(1);
      this.frameDone = true;
    };
    this.ppu.onHBlank = () => this.sys.dmaTrigger(2);
    this.apu.fifoARequest = () => this.sys.dmaTrigger(3, 0);
    this.apu.fifoBRequest = () => this.sys.dmaTrigger(3, 1);

    this.bus.sramRead = (a) => this.save.read8(a);
    this.bus.sramWrite = (a, v) => this.save.write8(a, v);
    this.bus.eepromRead = () => this.save.eepromRead();
    this.bus.eepromWrite = (v) => this.save.eepromWrite(v);
    this.bus.eepromAt = (a) => this.save.eepromAt(a);
  }

  // ------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------

  loadRom(data: Uint8Array, bios?: Uint8Array | null): RomInfo {
    this.bus.loadRom(data);
    this.save = createSave(detectSaveKind(data), data.length);
    this.romInfo = {
      title: ascii(data, 0xa0, 12).replace(/\0.*$/, "").trim(),
      code: ascii(data, 0xac, 4),
      maker: ascii(data, 0xb0, 2),
      saveKind: this.save.kind,
    };
    if (bios && bios.length >= 0x4000) {
      this.bus.bios = bios.subarray(0, 0x4000).slice();
      this.cpu.biosPresent = true;
    } else {
      this.bus.bios = buildSyntheticBios();
      this.cpu.biosPresent = false;
    }
    this.powerOn();
    return this.romInfo;
  }

  /** Install/remove a real BIOS image at runtime. */
  setBios(bios: Uint8Array | null): void {
    if (bios && bios.length >= 0x4000) {
      this.bus.bios = bios.subarray(0, 0x4000).slice();
      this.cpu.biosPresent = true;
    } else {
      this.bus.bios = buildSyntheticBios();
      this.cpu.biosPresent = false;
    }
  }

  powerOn(): void {
    this.bus.ewram.fill(0);
    this.bus.iwram.fill(0);
    this.bus.pal.fill(0);
    this.bus.vram.fill(0);
    this.bus.oam.fill(0);
    this.bus.ioFallback.fill(0);
    this.ppu.reset();
    this.apu.reset();
    this.biosHle.reset();

    // Reset system IO state.
    this.sys.ie = 0; this.sys.if_ = 0; this.sys.ime = 0;
    this.sys.tmReload.fill(0); this.sys.tmCounter.fill(0); this.sys.tmCnt.fill(0);
    this.sys.dmaSad.fill(0); this.sys.dmaDad.fill(0);
    this.sys.dmaCntL.fill(0); this.sys.dmaCntH.fill(0);
    this.sys.keyinput = 0x3ff;
    this.sys.keycnt = 0;
    this.sys.waitcnt = 0;
    this.sys.postflg = 0;

    this.cycles = 0;
    this.frameDone = false;

    // Skip the boot animation: post-BIOS state.
    this.cpu.reset(0x08000000, false);
    this.biosHle.applyPostBootState();
    this.ppu.dispcnt = 0x0080; // forced blank, as the real BIOS leaves it
    // The real BIOS leaves the affine matrices at identity.
    this.ppu.bgpa[0] = 0x100; this.ppu.bgpd[0] = 0x100;
    this.ppu.bgpa[1] = 0x100; this.ppu.bgpd[1] = 0x100;
  }

  // ------------------------------------------------------------------
  // Frame loop
  // ------------------------------------------------------------------

  /** Emulate one frame (228 scanlines). Returns when a frame completed. */
  runFrame(): void {
    this.frameDone = false;
    let guard = CYCLES_PER_FRAME * 2;
    while (!this.frameDone && guard > 0) {
      const before = this.cycles;
      this.cpu.step();
      const elapsed = this.cycles - before;
      this.sys.advance(elapsed);
      this.ppu.advance(elapsed);
      this.apu.advance(elapsed);
      guard -= elapsed;
    }
    this.cycles -= CYCLES_PER_FRAME;
    if (this.cycles < 0) this.cycles = 0;
  }

  // ------------------------------------------------------------------
  // Input
  // ------------------------------------------------------------------

  setKeys(mask: number): void {
    const next = (~mask) & 0x3ff;
    if (next !== this.sys.keyinput) {
      this.sys.keyinput = next;
      this.sys.keyChanged();
    }
  }

  // ------------------------------------------------------------------
  // Save states (binary snapshot)
  // ------------------------------------------------------------------

  serializeState(): ArrayBuffer {
    const parts: ArrayBuffer[] = [];
    const push = (a: ArrayBufferView | ArrayBuffer) => {
      parts.push(a instanceof ArrayBuffer ? a : a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength) as ArrayBuffer);
    };
    // Header: magic + rom checksum-ish id
    const header = new Uint32Array([0x47424153, this.bus.rom.length, 1]);
    push(header);
    push(this.cpu.r);
    push(new Int32Array([this.cpu.cpsr, this.cpu.pc, this.cpu.halted ? 1 : 0]));
    push(this.bus.ewram);
    push(this.bus.iwram);
    push(this.bus.pal);
    push(this.bus.vram);
    push(this.bus.oam);
    push(this.bus.ioFallback);
    push(new Int32Array([
      this.ppu.dispcnt, this.ppu.dispstat, this.ppu.vcount,
      this.sys.ie, this.sys.if_, this.sys.ime,
      this.sys.keyinput, this.sys.keycnt, this.sys.waitcnt,
    ]));
    push(this.ppu.bgcnt);
    push(this.ppu.bghofs);
    push(this.ppu.bgvofs);
    push(this.ppu.bgpa); push(this.ppu.bgpb); push(this.ppu.bgpc); push(this.ppu.bgpd);
    push(this.ppu.bgx); push(this.ppu.bgy);
    push(new Int32Array([this.ppu.win0h, this.ppu.win1h, this.ppu.win0v, this.ppu.win1v,
      this.ppu.winin, this.ppu.winout, this.ppu.mosaic,
      this.ppu.bldcnt, this.ppu.bldalpha, this.ppu.bldy]));
    push(this.sys.tmReload); push(this.sys.tmCounter); push(this.sys.tmCnt);
    push(this.sys.dmaSad); push(this.sys.dmaDad); push(this.sys.dmaCntL); push(this.sys.dmaCntH);
    push(new Uint8Array(this.save.data));

    let total = 0;
    for (const p of parts) total += p.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(new Uint8Array(p), off); off += p.byteLength; }
    return out.buffer as ArrayBuffer;
  }

  deserializeState(buf: ArrayBuffer): boolean {
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    if (bytes.length < 12 || view.getUint32(0, true) !== 0x47424153) return false;
    let off = 12;
    const take = (n: number) => { const s = bytes.slice(off, off + n); off += n; return s; };
    this.cpu.r.set(new Int32Array(take(64).buffer.slice(0) as ArrayBuffer));
    const c = new Int32Array(take(12).buffer.slice(0) as ArrayBuffer);
    this.cpu.cpsr = c[0];
    this.bus.ewram.set(take(256 * 1024));
    this.bus.iwram.set(take(32 * 1024));
    this.bus.pal.set(take(1024));
    this.bus.vram.set(take(96 * 1024));
    this.bus.oam.set(take(1024));
    this.bus.ioFallback.set(take(0x800));
    const io = new Int32Array(take(40).buffer.slice(0) as ArrayBuffer);
    this.ppu.dispcnt = io[0]; this.ppu.dispstat = io[1]; this.ppu.vcount = io[2];
    this.sys.ie = io[3]; this.sys.if_ = io[4]; this.sys.ime = io[5];
    this.sys.keyinput = io[6]; this.sys.keycnt = io[7]; this.sys.waitcnt = io[8];
    this.ppu.bgcnt.set(new Uint16Array(take(8).buffer.slice(0) as ArrayBuffer));
    this.ppu.bghofs.set(new Uint16Array(take(8).buffer.slice(0) as ArrayBuffer));
    this.ppu.bgvofs.set(new Uint16Array(take(8).buffer.slice(0) as ArrayBuffer));
    this.ppu.bgpa.set(new Int16Array(take(4).buffer.slice(0) as ArrayBuffer));
    this.ppu.bgpb.set(new Int16Array(take(4).buffer.slice(0) as ArrayBuffer));
    this.ppu.bgpc.set(new Int16Array(take(4).buffer.slice(0) as ArrayBuffer));
    this.ppu.bgpd.set(new Int16Array(take(4).buffer.slice(0) as ArrayBuffer));
    this.ppu.bgx.set(new Int32Array(take(8).buffer.slice(0) as ArrayBuffer));
    this.ppu.bgy.set(new Int32Array(take(8).buffer.slice(0) as ArrayBuffer));
    const misc = new Int32Array(take(40).buffer.slice(0) as ArrayBuffer);
    [this.ppu.win0h, this.ppu.win1h, this.ppu.win0v, this.ppu.win1v,
      this.ppu.winin, this.ppu.winout, this.ppu.mosaic,
      this.ppu.bldcnt, this.ppu.bldalpha, this.ppu.bldy] = misc;
    this.sys.tmReload.set(new Uint16Array(take(8).buffer.slice(0) as ArrayBuffer));
    this.sys.tmCounter.set(new Uint16Array(take(8).buffer.slice(0) as ArrayBuffer));
    this.sys.tmCnt.set(new Uint16Array(take(8).buffer.slice(0) as ArrayBuffer));
    this.sys.dmaSad.set(new Uint32Array(take(16).buffer.slice(0) as ArrayBuffer));
    this.sys.dmaDad.set(new Uint32Array(take(16).buffer.slice(0) as ArrayBuffer));
    this.sys.dmaCntL.set(new Uint16Array(take(8).buffer.slice(0) as ArrayBuffer));
    this.sys.dmaCntH.set(new Uint16Array(take(8).buffer.slice(0) as ArrayBuffer));
    this.save.data.set(take(this.save.size));
    // Restore pipeline: pc is pushed through cpu.pc already? We stored pc
    // but the pipeline needs a flush. Set pc then flush.
    this.cpu.pc = c[1];
    this.cpu.halted = c[2] !== 0;
    this.cpu.thumbMode = (this.cpu.cpsr & 0x20) !== 0;
    this.cpu.flush();
    return true;
  }
}

function ascii(data: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = data[off + i];
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : "";
  }
  return s;
}
