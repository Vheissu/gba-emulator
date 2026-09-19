// The GBA machine: wires CPU + bus + PPU + APU + system IO + saves + BIOS
// and owns the frame loop.

import { Bus } from "./bus";
import { CPU } from "./cpu";
import { PPU } from "./ppu";
import { APU } from "./apu";
import { System, DmaTiming } from "./system";
import { Gpio } from "./gpio";
import { BiosHLE, buildSyntheticBios } from "./bios";
import { SaveDevice, SaveKind, createSave, detectSaveKind } from "./saves";
import { StateReader, StateWriter } from "./state";

export const CPU_HZ = 16777216;
export const CYCLES_PER_FRAME = 280896;
export const FRAME_MS = (CYCLES_PER_FRAME / CPU_HZ) * 1000;

const BIOS_SIZE = 0x4000;
const STATE_MAGIC = 0x53424741; // "AGBS"
const STATE_VERSION = 2;

export interface RomInfo {
  title: string;
  code: string;
  maker: string;
  saveKind: SaveKind;
}

/** A RAM patch applied once per frame (cheat codes). */
export interface Patch {
  addr: number;
  value: number;
  /** Bytes to write: 1, 2 or 4. */
  size: number;
}

export class GBA {
  readonly bus = new Bus();
  readonly cpu = new CPU();
  readonly ppu = new PPU();
  readonly apu = new APU();
  readonly sys = new System();
  readonly gpio = new Gpio();
  private readonly biosHle = new BiosHLE();

  save: SaveDevice = createSave("none");
  romInfo: RomInfo | null = null;
  patches: Patch[] = [];

  private romId = 0;
  private frameDone = false;
  /** Cycle count the timers/PPU/APU have been advanced to. */
  private syncedTo = 0;
  private syncing = false;

  constructor() {
    const { bus, cpu, ppu, apu, sys } = this;
    cpu.bus = bus;
    cpu.swiHandler = (n) => this.biosHle.swi(n);
    sys.bus = bus; sys.cpu = cpu; sys.apu = apu;
    bus.ppu = ppu; bus.apu = apu; bus.sys = sys; bus.gpio = this.gpio; bus.save = this.save;
    bus.ioSync = () => this.sync();
    ppu.vram = bus.vram; ppu.pal16 = bus.pal16; ppu.oam16 = bus.oam16;
    this.biosHle.cpu = cpu; this.biosHle.bus = bus; this.biosHle.sys = sys;

    ppu.requestIrq = (bit) => sys.requestIrq(bit);
    ppu.onVBlank = () => { sys.dmaTrigger(DmaTiming.VBlank); this.frameDone = true; };
    ppu.onHBlank = () => sys.dmaTrigger(DmaTiming.HBlank);
    apu.onFifoRequest = (fifo) => sys.dmaTrigger(DmaTiming.Special, fifo);
    this.setBios(null);
  }

  // ------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------

  loadRom(data: Uint8Array): RomInfo {
    this.bus.loadRom(data);
    this.save = this.bus.save = createSave(detectSaveKind(data));
    this.romId = (fnv1a(data.subarray(0, Math.min(data.length, 0x10000))) ^ data.length) >>> 0;
    this.romInfo = {
      title: ascii(data, 0xa0, 12),
      code: ascii(data, 0xac, 4),
      maker: ascii(data, 0xb0, 2),
      saveKind: this.save.kind,
    };
    this.patches = [];
    this.reset();
    return this.romInfo;
  }

  /** Install a real BIOS image, or null for the built-in HLE one. Takes
   *  effect from the next reset. */
  setBios(image: Uint8Array | null): void {
    const real = image !== null && image.length >= BIOS_SIZE;
    this.bus.setBios(real ? image : buildSyntheticBios());
    this.cpu.biosPresent = real;
  }

  /** Power-cycle: everything but the cartridge's save memory. */
  reset(): void {
    this.bus.reset();
    this.ppu.reset();
    this.apu.reset();
    this.sys.reset();
    this.gpio.reset();
    this.biosHle.reset();
    this.syncedTo = 0;
    this.frameDone = false;
    // Start where the BIOS would hand over, skipping the boot animation.
    this.cpu.bootState(0x08000000);
  }

  // ------------------------------------------------------------------
  // Frame loop
  // ------------------------------------------------------------------

  /** Advance timers, video and audio to the CPU's current cycle. */
  private sync(): void {
    // DMA started by a device event lands back here through its IO writes.
    if (this.syncing) return;
    this.syncing = true;
    const elapsed = this.bus.cycles - this.syncedTo;
    this.syncedTo = this.bus.cycles;
    if (elapsed > 0) {
      this.sys.advance(elapsed);
      this.ppu.advance(elapsed);
      this.apu.advance(elapsed);
    }
    this.syncing = false;
  }

  /** Emulate until the next VBlank. */
  runFrame(): void {
    const { bus, cpu, sys, ppu } = this;
    this.frameDone = false;
    while (!this.frameDone) {
      // Devices only change state on their own at known points, so the CPU
      // can run undisturbed up to the nearest one.
      const target = this.syncedTo + Math.min(ppu.cyclesUntilEvent(), sys.cyclesUntilEvent());
      if (cpu.halted) bus.cycles = Math.max(bus.cycles, target);
      else while (bus.cycles < target && !cpu.halted) cpu.step();
      this.sync();
    }
    if (bus.cycles > 0x40000000) {
      bus.cycles -= 0x40000000;
      this.syncedTo -= 0x40000000;
    }
    for (const p of this.patches) this.applyPatch(p);
  }

  /** Execute a single instruction (or, when halted, skip to the next
   *  device event). For tracing and debugging tools. */
  step(): void {
    const { bus, cpu } = this;
    if (cpu.halted) bus.cycles = this.syncedTo + Math.min(this.ppu.cyclesUntilEvent(), this.sys.cyclesUntilEvent());
    else cpu.step();
    this.sync();
  }

  private applyPatch(p: Patch): void {
    if (p.size === 1) this.bus.poke8(p.addr, p.value);
    else if (p.size === 2) this.bus.poke16(p.addr, p.value);
    else this.bus.poke32(p.addr, p.value);
  }

  /** `pressed`: bit set = button down, in KEYINPUT bit order. */
  setKeys(pressed: number): void {
    this.sys.setKeys(pressed);
  }

  // ------------------------------------------------------------------
  // Save states
  // ------------------------------------------------------------------

  serializeState(): Uint8Array {
    this.sync();
    const w = new StateWriter();
    w.u32(STATE_MAGIC); w.u32(STATE_VERSION); w.u32(this.romId);
    this.bus.saveState(w);
    this.cpu.saveState(w);
    this.sys.saveState(w);
    this.ppu.saveState(w);
    this.apu.saveState(w);
    this.gpio.saveState(w);
    this.biosHle.saveState(w);
    this.save.saveState(w);
    return w.finish();
  }

  /** Returns false (leaving the machine untouched) if the state belongs to
   *  another ROM or an older format. */
  deserializeState(data: Uint8Array): boolean {
    const r = new StateReader(data);
    try {
      if (r.u32() !== STATE_MAGIC || r.u32() !== STATE_VERSION || r.u32() !== this.romId) return false;
    } catch {
      return false;
    }
    this.bus.loadState(r);
    this.cpu.loadState(r);
    this.sys.loadState(r);
    this.ppu.loadState(r);
    this.apu.loadState(r);
    this.gpio.loadState(r);
    this.biosHle.loadState(r);
    this.save.loadState(r);
    this.syncedTo = this.bus.cycles;
    this.frameDone = false;
    return true;
  }
}

function ascii(data: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = data[off + i];
    if (c === 0) break;
    if (c >= 32 && c < 127) s += String.fromCharCode(c);
  }
  return s.trim();
}

function fnv1a(data: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 0x01000193);
  return h >>> 0;
}
