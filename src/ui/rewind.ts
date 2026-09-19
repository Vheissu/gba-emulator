// Rewind buffer: a ring of recent save states captured every few frames.

import type { GBA } from "../emu/gba";

const CAPTURE_INTERVAL = 6;   // frames between snapshots (~10 per second)
const CAPACITY = 180;         // ~18 seconds, roughly 70 MB

export class Rewind {
  private states: Uint8Array[] = [];
  private sinceCapture = 0;

  constructor(private gba: GBA) {}

  clear(): void {
    this.states.length = 0;
    this.sinceCapture = 0;
  }

  /** Call once per emulated frame while playing forwards. */
  record(): void {
    if (++this.sinceCapture < CAPTURE_INTERVAL) return;
    this.sinceCapture = 0;
    if (this.states.length === CAPACITY) this.states.shift();
    this.states.push(this.gba.serializeState());
  }

  /** Step back one snapshot and render it. Returns false once history is
   *  exhausted (the oldest snapshot is kept to resume from). */
  stepBack(): boolean {
    const state = this.states.length > 1 ? this.states.pop()! : this.states[0];
    if (!state) return false;
    this.gba.deserializeState(state);
    this.gba.runFrame(); // redraw the framebuffer for this point in time
    this.gba.apu.clearOutput();
    return this.states.length > 1;
  }

  /** Seconds of history available. */
  get seconds(): number {
    return (this.states.length * CAPTURE_INTERVAL) / 60;
  }
}
