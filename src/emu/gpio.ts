// Cartridge GPIO port (0x080000C4-C8) with a Seiko S-3511 real-time clock
// on it, as found in Pokémon Ruby/Sapphire/Emerald, Boktai and others.
//   pin 0 = SCK, pin 1 = SIO, pin 2 = CS

import type { StateReader, StateWriter } from "./state";

const PIN_SCK = 1;
const PIN_SIO = 2;
const PIN_CS = 4;

// Command numbers as they arrive (bit-reversed relative to the datasheet).
const CMD_RESET = 0;
const CMD_DATETIME = 2;
const CMD_CONTROL = 4;
const CMD_TIME = 6;
const CMD_BYTES = [0, 0, 7, 0, 1, 0, 3, 0];

const CONTROL_24H = 0x40;

function bcd(n: number): number {
  return (Math.floor(n / 10) << 4) | (n % 10);
}

export class Gpio {
  /** Wall-clock source; replaceable so tests can pin the time. */
  now: () => Date = () => new Date();

  private data = 0;
  private direction = 0;
  /** Set by the game writing 1 to 0xC8; until then the port reads as ROM. */
  readable = false;

  // RTC serial state
  private step = 0;
  private bits = 0;
  private bitsRead = 0;
  private bytesLeft = 0;
  private command = 0;
  private active = false;
  private reading = false;
  private control = CONTROL_24H;
  private time = new Uint8Array(7);
  private sioOut = 1;

  reset(): void {
    this.data = this.direction = 0;
    this.readable = false;
    this.step = this.bits = this.bitsRead = this.bytesLeft = 0;
    this.active = this.reading = false;
    this.control = CONTROL_24H;
    this.sioOut = 1;
  }

  read(off: number): number {
    switch (off) {
      case 0xc4: {
        // Input pins show what the RTC drives; output pins read back.
        const driven = (this.data & ~PIN_SIO) | (this.sioOut ? PIN_SIO : 0);
        return (this.data & this.direction) | (driven & ~this.direction);
      }
      case 0xc6: return this.direction;
      default: return this.readable ? 1 : 0;
    }
  }

  write(off: number, value: number): void {
    switch (off) {
      case 0xc4:
        this.data = value & 0xf;
        this.clock((this.data & this.direction) | (this.sioOut && !(this.direction & PIN_SIO) ? PIN_SIO : 0));
        return;
      case 0xc6: this.direction = value & 0xf; return;
      case 0xc8: this.readable = (value & 1) !== 0; return;
    }
  }

  private clock(pins: number): void {
    switch (this.step) {
      case 0:
        if ((pins & (PIN_SCK | PIN_CS)) === PIN_SCK) this.step = 1;
        return;
      case 1:
        if ((pins & (PIN_SCK | PIN_CS)) === (PIN_SCK | PIN_CS)) this.step = 2;
        else if ((pins & (PIN_SCK | PIN_CS)) !== PIN_SCK) this.step = 0;
        return;
    }
    if (!(pins & PIN_CS)) {
      // Chip deselected: abandon the transfer.
      this.step = pins & PIN_SCK ? 1 : 0;
      this.bitsRead = this.bytesLeft = 0;
      this.active = this.reading = false;
      return;
    }
    if (!(pins & PIN_SCK)) {
      // SCK low: the master presents its bit.
      this.bits = (this.bits & ~(1 << this.bitsRead)) | (((pins & PIN_SIO) >> 1) << this.bitsRead);
      return;
    }
    // SCK rising edge.
    if (this.reading) {
      this.sioOut = (this.outputByte() >> this.bitsRead) & 1;
      if (++this.bitsRead === 8) {
        this.bitsRead = 0;
        if (--this.bytesLeft <= 0) this.active = this.reading = false;
      }
    } else if (++this.bitsRead === 8) {
      this.processByte();
    }
  }

  private processByte(): void {
    const byte = this.bits;
    this.bits = this.bitsRead = 0;
    if (!this.active) {
      if ((byte & 0xf) !== 0x6) return;
      this.command = (byte >> 4) & 7;
      this.reading = (byte & 0x80) !== 0;
      this.bytesLeft = CMD_BYTES[this.command];
      this.active = this.bytesLeft > 0;
      if (this.command === CMD_RESET) this.control = 0;
      else if (this.command === CMD_DATETIME || this.command === CMD_TIME) this.latchTime();
      if (!this.active) this.reading = false;
      return;
    }
    // Only the control register is meaningfully writable; the clock itself
    // follows the host.
    if (this.command === CMD_CONTROL) this.control = byte;
    if (--this.bytesLeft <= 0) this.active = false;
  }

  private outputByte(): number {
    switch (this.command) {
      case CMD_DATETIME: return this.time[7 - this.bytesLeft];
      case CMD_TIME: return this.time[7 - this.bytesLeft];
      case CMD_CONTROL: return this.control;
      default: return 0;
    }
  }

  private latchTime(): void {
    const d = this.now();
    let hour = d.getHours();
    let pm = 0;
    if (!(this.control & CONTROL_24H)) {
      pm = hour >= 12 ? 0x80 : 0;
      hour %= 12;
    }
    this.time[0] = bcd(d.getFullYear() % 100);
    this.time[1] = bcd(d.getMonth() + 1);
    this.time[2] = bcd(d.getDate());
    this.time[3] = d.getDay();
    this.time[4] = bcd(hour) | pm;
    this.time[5] = bcd(d.getMinutes());
    this.time[6] = bcd(d.getSeconds());
  }

  saveState(w: StateWriter): void {
    w.u8(this.data); w.u8(this.direction); w.bool(this.readable);
    w.u8(this.step); w.u8(this.bits); w.u8(this.bitsRead); w.u8(this.bytesLeft);
    w.u8(this.command); w.bool(this.active); w.bool(this.reading);
    w.u8(this.control); w.bytes(this.time); w.u8(this.sioOut);
  }

  loadState(r: StateReader): void {
    this.data = r.u8(); this.direction = r.u8(); this.readable = r.bool();
    this.step = r.u8(); this.bits = r.u8(); this.bitsRead = r.u8(); this.bytesLeft = r.u8();
    this.command = r.u8(); this.active = r.bool(); this.reading = r.bool();
    this.control = r.u8(); r.bytesInto(this.time); this.sioOut = r.u8();
  }
}
