// Headless test harness: load a ROM, run N frames, dump the framebuffer
// to a PNG. Usage: npx tsx tools/run-test.mts <rom> <frames> <out.png>
import { readFileSync, writeFileSync } from "node:fs";
import { GBA } from "../src/emu/gba";
import { png } from "./png.mts";

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

writeFileSync(outPath || "frame.png", png(240, 160, gba.ppu.framebuffer));
console.log("Wrote", outPath || "frame.png");
