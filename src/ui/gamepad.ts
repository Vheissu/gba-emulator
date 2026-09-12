// Gamepad polling: standard-layout pads → GBA key mask.
// Position-correct Nintendo mapping: east = A, south = B.

export interface PadInfo {
  id: string;
  index: number;
}

export function pollGamepads(): { mask: number; pad: PadInfo | null } {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let mask = 0;
  let pad: PadInfo | null = null;
  for (const p of pads) {
    if (!p || !p.connected) continue;
    pad = { id: p.id, index: p.index };
    const b = (i: number) => p.buttons[i] && p.buttons[i].pressed;
    if (b(1) || b(3)) mask |= 1;    // east / north → A
    if (b(0) || b(2)) mask |= 2;    // south / west → B
    if (b(8)) mask |= 4;            // select
    if (b(9)) mask |= 8;            // start
    if (b(15)) mask |= 16;          // right
    if (b(14)) mask |= 32;          // left
    if (b(12)) mask |= 64;          // up
    if (b(13)) mask |= 128;         // down
    if (b(5) || b(7)) mask |= 256;  // RB / RT → R
    if (b(4) || b(6)) mask |= 512;  // LB / LT → L
    const ax = p.axes[0] || 0;
    const ay = p.axes[1] || 0;
    if (ax > 0.5) mask |= 16;
    if (ax < -0.5) mask |= 32;
    if (ay > 0.5) mask |= 128;
    if (ay < -0.5) mask |= 64;
    break; // first connected pad wins
  }
  return { mask, pad };
}
