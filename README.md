# AGB-EMU

A Game Boy Advance emulator written from scratch in TypeScript, running
entirely in the browser. No emulator libraries - the ARM7TDMI core, PPU,
APU, DMA/timers, save hardware and HLE BIOS are all implemented in this
repo.

![Made for the browser](https://img.shields.io/badge/platform-browser-56509f)

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Drop a `.gba` file onto the cartridge slot (or click it to browse). ROMs,
save RAM, save states and an optional BIOS are all persisted in
IndexedDB - nothing leaves your browser.

```bash
npm run build      # type-check + production bundle in dist/
```

## Controls

| Input            | GBA control          |
| ---------------- | -------------------- |
| Arrow keys       | D-Pad                |
| `X` / `Z`        | A / B                |
| `A` / `S`        | L / R                |
| `Enter` / `Shift`| Start / Select       |
| `Space` (hold)   | Fast-forward         |
| `F1` / `F2`      | Quick save / load    |

Any standard-layout gamepad works out of the box (Gamepad API):
south = B, east = A, shoulders = L/R, d-pad or left stick to move.
The on-console D-pad and buttons are also clickable/touchable.

## Features

- Full ARM7TDMI interpreter: ARM + Thumb, banked registers, exceptions,
  correct `r15` pipeline semantics (`pc+12` for register-specified shifts)
- PPU: video modes 0-5, text + affine backgrounds, sprites, windows,
  mosaic, alpha blending, forced blank
- APU: 4 PSG channels + 2 DMA-fed FIFOs, mixed to 48 kHz stereo into an
  AudioWorklet
- DMA (all 4 channels, all timing modes), timers with cascade + FIFO
  linkage, interrupt controller with HLE `IntrWait`/`VBlankIntrWait`
- Save hardware auto-detected from the ROM: SRAM, Flash 64K/128K with
  bank switching and ID commands, EEPROM
- Optional real `gba_bios.bin` (16 KB) support; without it a synthesized
  BIOS stub + HLE software interrupts are used
- Save states (3 slots with framebuffer thumbnails), fast-forward,
  CRT scanline overlay, fullscreen mode, persistent ROM library

## Project layout

```
src/emu/    emulator core (no DOM dependencies)
  cpu.ts    ARM7TDMI: ARM/Thumb interpreters, flags, exceptions
  bus.ts    memory map, waitstates, IO dispatch
  ppu.ts    renderer: modes 0-5, sprites, blending, windows
  apu.ts    sound: PSG channels, wave RAM, FIFOs, mixer
  system.ts timers, DMA, interrupts, keypad, serial stub
  saves.ts  SRAM / Flash / EEPROM cartridge hardware
  bios.ts   HLE SWIs + synthesized BIOS image
  gba.ts    machine wiring, frame loop, save states
src/ui/     browser glue (audio worklet, gamepad, IndexedDB, pixel font)
src/main.ts app orchestration + input + persistence
tools/      headless test rigs (run ROMs, trace, drive menus, e2e)
```

## Testing

The core is verified against the ARMWRESTLER CPU test ROM
(`testroms/`): all ARM and Thumb suites pass.

```bash
npx tsx tools/run-test.mts testroms/armwrestler-fixed.gba 600 frame.png
npx tsx tools/e2e.mts    # drives the real UI in Chrome (needs dev server)
```

## Notes

Only load ROMs of games you own. Accuracy is a work in progress -
waitstate modelling and APU mixing are approximate, and some games may
still hit unimplemented edge cases.
