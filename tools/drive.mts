// Headless driver: run a ROM, inject a key script, dump frames.
// Usage: npx tsx tools/drive.mts <rom> <script> <out.png>
//   script: comma-separated "frames:keymask" steps, e.g. "120:0,6:8,600:0"
//   keymask bits: 0=A 1=B 2=Select 3=Start 4=Right 5=Left 6=Up 7=Down 8=R 9=L
import { readFileSync, writeFileSync } from "node:fs";
import { GBA } from "../src/emu/gba";
import { png } from "./png.mts";

const [, , romPath, scriptArg, outPath] = process.argv;

const gba = new GBA();
const info = gba.loadRom(new Uint8Array(readFileSync(romPath!)));
console.log("ROM:", info);

const steps = (scriptArg || "300:0").split(",").map((s) => {
  const [f, k] = s.split(":");
  return { frames: parseInt(f, 10), keys: parseInt(k || "0", 10) };
});

for (const { frames, keys } of steps) {
  gba.setKeys(keys);
  for (let i = 0; i < frames; i++) gba.runFrame();
}
gba.setKeys(0);
console.log("pc:", gba.cpu.pc.toString(16), "cpsr:", gba.cpu.cpsr.toString(16));

writeFileSync(outPath || "frame.png", png(240, 160, gba.ppu.framebuffer));
console.log("Wrote", outPath || "frame.png");
