// Headless test harness: load a ROM, run N frames, dump the framebuffer
// to a PNG. Usage: npx tsx tools/run-test.mts <rom> <frames> <out.png>
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { GBA } from "../src/emu/gba";

const [, , romPath, framesArg, outPath] = process.argv;
const frames = parseInt(framesArg || "120", 10);

const gba = new GBA();
const rom = readFileSync(romPath!);
const info = gba.loadRom(new Uint8Array(rom));
console.log("ROM:", info);

const t0 = Date.now();
for (let i = 0; i < frames; i++) gba.runFrame();
const ms = Date.now() - t0;
console.log(`Ran ${frames} frames in ${ms}ms (${(frames / (ms / 1000)).toFixed(1)} fps)`);
console.log("pc:", gba.cpu.pc.toString(16), "cpsr:", gba.cpu.cpsr.toString(16));

// ---- PNG writer (minimal, truecolor RGBA) ----
function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const idat = deflateSync(raw);
  const chunks: Buffer[] = [];
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    chunks.push(Buffer.concat([len, td, crc]));
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  chunk("IHDR", ihdr);
  chunk("IDAT", idat);
  chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

writeFileSync(outPath || "frame.png", png(240, 160, gba.ppu.framebuffer));
console.log("Wrote", outPath || "frame.png");
