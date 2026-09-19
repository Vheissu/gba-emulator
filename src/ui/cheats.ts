// Raw memory-patch cheats, one per line:  AAAAAAAA:VV, :VVVV or :VVVVVVVV
// (a space works in place of the colon). Encrypted GameShark / Action
// Replay codes are not supported.

import type { Patch } from "../emu/gba";

export interface CheatParse {
  patches: Patch[];
  /** 1-based numbers of lines that could not be understood. */
  badLines: number[];
}

export function parseCheats(text: string): CheatParse {
  const patches: Patch[] = [];
  const badLines: number[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/[#;].*$/, "").trim();
    if (!line) return;
    const m = /^(?:0x)?([0-9a-f]{7,8})[:\s]+(?:0x)?([0-9a-f]{2}|[0-9a-f]{4}|[0-9a-f]{8})$/i.exec(line);
    const addr = m ? parseInt(m[1], 16) : -1;
    // Only work RAM is patchable.
    if (!m || (addr >>> 24 !== 0x02 && addr >>> 24 !== 0x03)) { badLines.push(i + 1); return; }
    patches.push({ addr, value: parseInt(m[2], 16), size: m[2].length / 2 });
  });
  return { patches, badLines };
}
