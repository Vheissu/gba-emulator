// Instruction tracer for debugging. Usage:
//   npx tsx tools/trace.mts <rom> [maxInstr] [startLoggingAt]
import { readFileSync } from "node:fs";
import { GBA } from "../src/emu/gba";

const [, , romPath, maxArg, skipArg] = process.argv;
const max = parseInt(maxArg || "200", 10);
const skip = parseInt(skipArg || "0", 10);

const gba = new GBA();
gba.loadRom(new Uint8Array(readFileSync(romPath!)));

const rname = (i: number) => "r" + i;
void rname;

let count = 0;
while (count < max) {
  const pc = gba.cpu.pc;
  const thumb = gba.cpu.isThumb;
  const instrAddr = (pc - (thumb ? 4 : 8)) >>> 0;
  if (count >= skip) {
    const instr = thumb ? gba.bus.peek16(instrAddr) : gba.bus.peek32(instrAddr);
    const regs = [0, 1, 2, 3, 12, 13, 14].map(i => `r${i}=${(gba.cpu.r[i] >>> 0).toString(16).padStart(8, "0")}`).join(" ");
    console.log(
      `${count.toString().padStart(6)} ${instrAddr.toString(16).padStart(8, "0")} ` +
      `${instr.toString(16).padStart(thumb ? 4 : 8, "0")} ${thumb ? "T" : "A"} ${regs} cpsr=${gba.cpu.cpsr.toString(16)}`
    );
    if (instrAddr >= 0x0e000000 || (instrAddr < 0x08000000 && instrAddr >= 0x4000)) {
      console.log("!! pc in invalid region");
      break;
    }
  }
  const before = gba.cycles;
  gba.cpu.step();
  const elapsed = gba.cycles - before;
  gba.sys.advance(elapsed);
  gba.ppu.advance(elapsed);
  gba.apu.advance(elapsed);
  count++;
}
