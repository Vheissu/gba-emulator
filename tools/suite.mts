// Regression suite: runs the self-checking test ROMs headlessly.
// jsmolka's ROMs leave the number of the first failed test in r12 (0 = all
// passed). Usage: npx tsx tools/suite.mts [--shots <dir>]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { GBA } from "../src/emu/gba";
import { png } from "./png.mts";

const TESTS = [
  "arm", "thumb", "memory", "bios", "none", "sram", "flash64", "flash128",
  "unsafe", "nes",
];

const shotsAt = process.argv.indexOf("--shots");
const shotDir = shotsAt >= 0 ? process.argv[shotsAt + 1] : null;
if (shotDir) mkdirSync(shotDir, { recursive: true });

let failed = 0;
for (const name of TESTS) {
  const gba = new GBA();
  gba.loadRom(new Uint8Array(readFileSync(`testroms/jsmolka/${name}.gba`)));
  for (let i = 0; i < 120; i++) gba.runFrame();
  const result = gba.cpu.r[12];
  if (result !== 0) failed++;
  console.log(`${result === 0 ? "pass" : "FAIL"}  ${name}${result ? `  (test ${result})` : ""}`);
  if (shotDir) writeFileSync(`${shotDir}/${name}.png`, png(240, 160, gba.ppu.framebuffer));
}
// Save states must resume bit-exactly.
{
  const hash = (a: Uint8Array) => a.reduce((h, v) => (Math.imul(h, 31) + v) | 0, 0);
  const gba = new GBA();
  gba.loadRom(new Uint8Array(readFileSync("testroms/celeste-classic.gba")));
  for (let i = 0; i < 300; i++) gba.runFrame();
  const state = gba.serializeState();
  for (let i = 0; i < 120; i++) gba.runFrame();
  const expected = hash(gba.ppu.framebuffer) ^ hash(gba.bus.ewram);
  const loaded = gba.deserializeState(state);
  for (let i = 0; i < 120; i++) gba.runFrame();
  const ok = loaded && expected === (hash(gba.ppu.framebuffer) ^ hash(gba.bus.ewram));
  if (!ok) failed++;
  console.log(`${ok ? "pass" : "FAIL"}  save-state round trip`);
}

console.log(failed ? `${failed} failing` : "all passing");
process.exit(failed ? 1 : 0);
