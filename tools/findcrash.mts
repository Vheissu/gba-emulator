// Runs until pc goes out of bounds, prints the last N PCs before it did.
import { readFileSync } from "node:fs";
import { GBA } from "../src/emu/gba";

const [, , romPath, maxArg] = process.argv;
const max = parseInt(maxArg || "5000000", 10);

const gba = new GBA();
gba.loadRom(new Uint8Array(readFileSync(romPath!)));

const history: string[] = [];
const HIST = 80;

let count = 0;
let prevExec = -1;
let prevThumb = false;
while (count < max) {
  const pc = gba.cpu.pc;
  const thumb = gba.cpu.isThumb;
  const execAddr = (pc - (thumb ? 4 : 8)) >>> 0;
  const memInstr = thumb ? gba.bus.peek16(execAddr) : gba.bus.peek32(execAddr);
  const execInstr = (gba.cpu as unknown as { pipe0: number }).pipe0;
  history.push(
    `${execAddr.toString(16).padStart(8, "0")} mem=${memInstr.toString(16).padStart(thumb ? 4 : 8, "0")} exec=${execInstr.toString(16).padStart(thumb ? 4 : 8, "0")} ${thumb ? "T" : "A"} ` +
    `r0=${(gba.cpu.r[0] >>> 0).toString(16)} r1=${(gba.cpu.r[1] >>> 0).toString(16)} ` +
    `r2=${(gba.cpu.r[2] >>> 0).toString(16)} r3=${(gba.cpu.r[3] >>> 0).toString(16)} ` +
    `r4=${(gba.cpu.r[4] >>> 0).toString(16)} r12=${(gba.cpu.r[12] >>> 0).toString(16)} sp=${(gba.cpu.r[13] >>> 0).toString(16)} ` +
    `lr=${(gba.cpu.r[14] >>> 0).toString(16)} cpsr=${gba.cpu.cpsr.toString(16)}`
  );
  if (history.length > HIST) history.shift();
  // detect a non-sequential control transfer landing in the string/data region
  if (prevExec !== -1) {
    const expected = prevExec + (prevThumb ? 2 : 4);
    if (execAddr !== expected && execAddr >= 0x08002840 && execAddr < 0x08004100) {
      console.log(`!! jumped into data at instr ${count}: ${execAddr.toString(16)}`);
      console.log(history.join("\n"));
      process.exit(0);
    }
    if (memInstr !== execInstr) {
      console.log(`!! stale pipeline at instr ${count}: execAddr=${execAddr.toString(16)} mem=${memInstr.toString(16)} exec=${execInstr.toString(16)}`);
      console.log(history.join("\n"));
      process.exit(0);
    }
  }
  prevExec = execAddr;
  prevThumb = thumb;
  // valid exec regions: BIOS <0x4000, EWRAM 0x02, IWRAM 0x03, ROM 0x08-0x0d
  const region = execAddr >>> 24;
  const valid = execAddr < 0x4000 || region === 2 || region === 3 || (region >= 8 && region <= 0xd);
  if (!valid) {
    console.log(`!! pc went wild at instr ${count}: ${execAddr.toString(16)}`);
    console.log(history.join("\n"));
    break;
  }
  const before = gba.cycles;
  gba.cpu.step();
  const elapsed = gba.cycles - before;
  gba.sys.advance(elapsed);
  gba.ppu.advance(elapsed);
  gba.apu.advance(elapsed);
  count++;
}
if (count >= max) console.log(`completed ${max} instructions, pc ok: ${gba.cpu.pc.toString(16)}`);
