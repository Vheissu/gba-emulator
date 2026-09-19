// Player input: keyboard (rebindable), on-screen buttons and gamepads,
// merged into one KEYINPUT-ordered bitmask.

import { pollGamepads, PadInfo } from "./gamepad";
import { BUTTON_BIT, Button, KeyBindings, normalizeCode } from "./settings";

export class Input {
  private keyboard = 0;
  private touch = 0;
  /** Keys released since the last poll. They stay down for that one poll
   *  so a tap shorter than a frame still registers. */
  private releasing = 0;
  private codeToBit = new Map<string, number>();
  /** Most recently polled gamepad, if any. */
  pad: PadInfo | null = null;

  constructor(bindings: KeyBindings) {
    this.setBindings(bindings);
    addEventListener("blur", () => { this.keyboard = this.releasing = 0; });
  }

  setBindings(bindings: KeyBindings): void {
    this.codeToBit.clear();
    for (const [button, code] of Object.entries(bindings)) {
      this.codeToBit.set(code, BUTTON_BIT[button as Button]);
    }
    this.keyboard = this.releasing = 0;
  }

  /** Returns true if the key is bound to a GBA button. */
  keyDown(code: string): boolean {
    const bit = this.codeToBit.get(normalizeCode(code));
    if (bit === undefined) return false;
    this.keyboard |= bit;
    this.releasing &= ~bit;
    return true;
  }

  keyUp(code: string): void {
    const bit = this.codeToBit.get(normalizeCode(code));
    if (bit !== undefined) this.releasing |= bit;
  }

  /** Wire up on-screen buttons carrying a `data-bit` attribute. */
  bindTouch(buttons: Iterable<HTMLElement>): void {
    for (const el of buttons) {
      const bit = Number(el.dataset.bit);
      const press = (on: boolean) => {
        if (on) this.touch |= bit; else this.touch &= ~bit;
        el.classList.toggle("pressed", on);
      };
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
        press(true);
      });
      for (const evt of ["pointerup", "pointercancel", "lostpointercapture"]) {
        el.addEventListener(evt, () => press(false));
      }
    }
  }

  /** Current button mask (bit set = pressed). */
  poll(): number {
    const { mask, pad } = pollGamepads();
    this.pad = pad;
    let pressed = this.keyboard | this.touch | mask;
    this.keyboard &= ~this.releasing;
    this.releasing = 0;
    // The d-pad cannot physically press opposite directions.
    if ((pressed & 0x30) === 0x30) pressed &= ~0x30;
    if ((pressed & 0xc0) === 0xc0) pressed &= ~0xc0;
    return pressed;
  }
}
