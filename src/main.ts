import "./style.css";
import "@fontsource/chakra-petch/400.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/chakra-petch/700.css";
import "@fontsource/chakra-petch/700-italic.css";

import { GBA, FRAME_MS } from "./emu/gba";
import { AudioOut } from "./ui/audio";
import { Input } from "./ui/input";
import { Rewind } from "./ui/rewind";
import { parseCheats } from "./ui/cheats";
import { extractRom, isZip } from "./ui/zip";
import { drawPixelTextCentered } from "./ui/pixelfont";
import * as library from "./ui/library";
import { BUTTONS, DEFAULT_KEYS, keyLabel, loadSettings, normalizeCode, saveSettings } from "./ui/settings";

const STATE_SLOTS = 4;
const QUICK_SLOT = 0;
const SPEEDS = [1, 2, 4, 8];
const HOLD_SPEED = 8;
/** Wall-clock budget for emulation per animation frame. */
const FRAME_BUDGET_MS = 13;
const MAX_ROM_SIZE = 32 * 1024 * 1024;
const BIOS_SIZE = 16384;
const SCREENSHOT_SCALE = 4;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const screen = $<HTMLCanvasElement>("screen");
const ctx = screen.getContext("2d")!;
const screenMsg = $("screenMsg");
const cart = $("cart");
const cartTitle = $("cartTitle");
const cartMeta = $("cartMeta");
const dropzone = $("dropzone");
const slotHint = $("slotHint");
const powerLed = $("powerLed");
const fpsChip = $("fps");
const padChip = $("padStatus");
const audioBtn = $("audioBtn");
const biosChip = $("biosStatus");
const biosBtn = $("biosBtn");
const biosInput = $<HTMLInputElement>("biosInput");
const romInput = $<HTMLInputElement>("romInput");
const savInput = $<HTMLInputElement>("savInput");
const pauseBtn = $<HTMLButtonElement>("pauseBtn");
const resetBtn = $<HTMLButtonElement>("resetBtn");
const rewindBtn = $<HTMLButtonElement>("rewindBtn");
const speedBtn = $<HTMLButtonElement>("speedBtn");
const shotBtn = $<HTMLButtonElement>("shotBtn");
const fsBtn = $<HTMLButtonElement>("fsBtn");
const ejectBtn = $<HTMLButtonElement>("ejectBtn");
const crtOverlay = $("crt");
const consoleEl = $("consoleEl");
const stateSlots = $("stateSlots");
const libraryEl = $("library");
const keymapEl = $("keymap");
const batteryInfo = $("batteryInfo");
const savExport = $<HTMLButtonElement>("savExport");
const savImport = $<HTMLButtonElement>("savImport");
const cheatText = $<HTMLTextAreaElement>("cheatText");
const cheatApply = $<HTMLButtonElement>("cheatApply");
const cheatStatus = $("cheatStatus");
const toastEl = $("toast");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const settings = loadSettings();
const gba = new GBA();
const audio = new AudioOut();
const input = new Input(settings.keys);
const rewind = new Rewind(gba);

/** The inserted cartridge, or null when the slot is empty. */
let rom: { id: string; name: string; data: Uint8Array } | null = null;
let bios: Uint8Array | null = null;

let paused = false;
let speedIndex = 0;
let fastHeld = false;
let rewindHeld = false;
let rewindTick = 0;
/** Button whose key binding is being captured, if any. */
let rebinding: (typeof BUTTONS)[number] | null = null;

let acc = 0;
let lastT = 0;
let fpsFrames = 0;
let fpsT = 0;
let blinkT = 0;
let blinkOn = true;
let lastPadId = "";

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const frame = new ImageData(240, 160);
const blended = new Uint8ClampedArray(frame.data.length);

function present(): void {
  const src = gba.ppu.framebuffer;
  if (settings.ghosting) {
    // Average with what was last shown, like the slow-responding LCD.
    const out = frame.data;
    for (let i = 0; i < src.length; i++) out[i] = blended[i] = (src[i] + blended[i] + 1) >> 1;
  } else {
    frame.data.set(src);
    blended.set(src);
  }
  ctx.putImageData(frame, 0, 0);
}

function drawIdleScreen(): void {
  ctx.fillStyle = "#0b0913";
  ctx.fillRect(0, 0, 240, 160);
  drawPixelTextCentered(ctx, 120, 52, "AGB-EMU", 3, "#56509f");
  drawPixelTextCentered(ctx, 120, 84, "GAME BOY ADVANCE", 1, "#8f88b5");
  if (blinkOn) drawPixelTextCentered(ctx, 120, 112, "INSERT CARTRIDGE", 2, "#d8d2f0");
  drawPixelTextCentered(ctx, 120, 138, "DROP A ROM OR CLICK THE SLOT", 1, "#5d5680");
}

function download(blob: Blob, filename: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function screenshot(): void {
  if (!rom) return;
  const name = rom.name;
  const big = document.createElement("canvas");
  big.width = 240 * SCREENSHOT_SCALE;
  big.height = 160 * SCREENSHOT_SCALE;
  const bctx = big.getContext("2d")!;
  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(screen, 0, 0, big.width, big.height);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  big.toBlob((blob) => { if (blob) download(blob, `${name} ${stamp}.png`); }, "image/png");
  toast("Screenshot saved");
}

// ---------------------------------------------------------------------------
// Toasts + status
// ---------------------------------------------------------------------------

let toastTimer = 0;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toastEl.hidden = true; }, 2600);
}

function currentSpeed(): number {
  return fastHeld ? HOLD_SPEED : SPEEDS[speedIndex];
}

function updateDeck(): void {
  const hasRom = rom !== null;
  for (const b of [pauseBtn, resetBtn, speedBtn, shotBtn, ejectBtn, cheatApply]) b.disabled = !hasRom;
  rewindBtn.disabled = !hasRom || !settings.rewind;
  cheatText.disabled = !hasRom;
  pauseBtn.textContent = paused ? "RESUME" : "PAUSE";
  speedBtn.textContent = `${SPEEDS[speedIndex]}× SPEED`;
  speedBtn.classList.toggle("on", speedIndex !== 0);
  powerLed.classList.toggle("on", hasRom && !paused);
  powerLed.classList.toggle("paused", hasRom && paused);
  screenMsg.textContent = !hasRom ? "" : rewindHeld ? "◀◀ REWIND" : paused ? "PAUSED" : "";
}

function setPaused(on: boolean): void {
  if (!rom) return;
  paused = on;
  updateDeck();
}

// ---------------------------------------------------------------------------
// Cartridge
// ---------------------------------------------------------------------------

function fmtSize(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

async function openFile(file: File): Promise<void> {
  let data: Uint8Array = new Uint8Array(await file.arrayBuffer());
  let name = file.name;
  if (/\.(sav|srm)$/i.test(name)) { importBattery(data); return; }
  if (data.length === BIOS_SIZE) { await installBios(data); return; }
  if (isZip(data)) {
    const entry = await extractRom(data).catch(() => null);
    if (!entry) { toast("No GBA ROM found in that archive."); return; }
    ({ data, name } = entry);
  }
  await insertRom(data, name.replace(/\.[^.]+$/, ""));
}

async function insertRom(data: Uint8Array, name: string): Promise<void> {
  if (data.length < 0xc0 || data.length > MAX_ROM_SIZE) {
    toast("That file doesn't look like a GBA ROM.");
    return;
  }
  persistBattery();
  const entry = await library.addRom(data, name);
  rom = { id: entry.id, name, data };
  gba.patches = [];
  await powerOn();

  const info = gba.romInfo!;
  cartTitle.textContent = (info.title || name).toUpperCase();
  const saveLabel = info.saveKind === "none" ? "NO SAVE" : info.saveKind.toUpperCase();
  cartMeta.textContent = [info.code, fmtSize(data.length), saveLabel].filter(Boolean).join(" · ");
  cart.hidden = false;
  requestAnimationFrame(() => cart.classList.add("inserted"));
  slotHint.textContent = "CARTRIDGE INSERTED";

  cheatText.value = localStorage.getItem(`agb-emu:cheats:${rom.id}`) ?? "";
  applyCheats(false);
  updateBatteryInfo();
  void renderLibrary();
  void renderSlots();
  toast(`${cartTitle.textContent} loaded`);
}

/** (Re)boot the inserted cartridge with its battery save restored. */
async function powerOn(): Promise<void> {
  if (!rom) return;
  const patches = gba.patches;
  gba.setBios(bios);
  gba.loadRom(rom.data);
  gba.patches = patches;
  const battery = await library.loadBattery(rom.id);
  if (battery && gba.save.size > 0) gba.save.deserialize(battery);
  rewind.clear();
  gba.apu.clearOutput();
  paused = false;
  acc = 0;
  updateDeck();
}

function eject(): void {
  persistBattery();
  rom = null;
  paused = false;
  gba.patches = [];
  rewind.clear();
  cart.classList.remove("inserted");
  setTimeout(() => { if (!rom) cart.hidden = true; }, 450);
  slotHint.textContent = "DROP A .GBA OR .ZIP · CLICK TO BROWSE";
  cheatText.value = "";
  cheatStatus.textContent = "";
  updateDeck();
  updateBatteryInfo();
  void renderLibrary();
  void renderSlots();
  drawIdleScreen();
}

// ---------------------------------------------------------------------------
// Battery save
// ---------------------------------------------------------------------------

function persistBattery(): void {
  if (!rom || !gba.save.dirty) return;
  gba.save.dirty = false;
  void library.storeBattery(rom.id, gba.save.serialize());
}
setInterval(persistBattery, 1000);
addEventListener("pagehide", persistBattery);
document.addEventListener("visibilitychange", persistBattery);

function updateBatteryInfo(): void {
  if (!rom) batteryInfo.textContent = "No cartridge inserted.";
  else if (gba.save.kind === "none") batteryInfo.textContent = "This cartridge has no save memory.";
  else batteryInfo.textContent = `${gba.save.kind.toUpperCase()} · ${fmtSize(gba.save.size)}`;
  savExport.disabled = savImport.disabled = rom === null || gba.save.kind === "none";
}

function importBattery(data: Uint8Array): void {
  if (!rom || gba.save.kind === "none") { toast("Insert the matching cartridge first."); return; }
  gba.save.deserialize(data);
  gba.save.dirty = true;
  persistBattery();
  void powerOn().then(() => toast("Save imported · game restarted"));
}

savExport.addEventListener("click", () => {
  if (rom) download(new Blob([gba.save.serialize().slice().buffer]), `${rom.name}.sav`);
});
savImport.addEventListener("click", () => savInput.click());
savInput.addEventListener("change", () => {
  const f = savInput.files?.[0];
  savInput.value = "";
  if (f) void f.arrayBuffer().then((b) => importBattery(new Uint8Array(b)));
});

// ---------------------------------------------------------------------------
// Save states
// ---------------------------------------------------------------------------

const thumbCanvas = document.createElement("canvas");
thumbCanvas.width = 120; thumbCanvas.height = 80;
const thumbCtx = thumbCanvas.getContext("2d")!;

async function saveState(slot: number): Promise<void> {
  if (!rom) return;
  thumbCtx.drawImage(screen, 0, 0, 120, 80);
  await library.putSlot(rom.id, slot, {
    state: gba.serializeState(),
    shot: thumbCanvas.toDataURL("image/png"),
    ts: Date.now(),
  });
  void renderSlots();
  toast(slot === QUICK_SLOT ? "Quick state saved" : `State saved · slot ${slot}`);
}

async function loadState(slot: number): Promise<void> {
  if (!rom) return;
  const rec = await library.getSlot(rom.id, slot);
  if (!rec) { toast("That slot is empty."); return; }
  if (!gba.deserializeState(rec.state)) { toast("That state is from another ROM or an older version."); return; }
  rewind.clear();
  gba.runFrame();
  gba.apu.clearOutput();
  present();
  toast(slot === QUICK_SLOT ? "Quick state loaded" : `State loaded · slot ${slot}`);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function note(text: string): HTMLElement {
  return el("p", "panel-note", text);
}

async function renderSlots(): Promise<void> {
  if (!rom) { stateSlots.replaceChildren(note("Insert a cartridge to use save states.")); return; }
  const id = rom.id;
  const rows: HTMLElement[] = [];
  for (let i = 0; i < STATE_SLOTS; i++) {
    const rec = await library.getSlot(id, i);
    const row = el("div", "slot-row");
    if (rec) {
      const img = document.createElement("img");
      img.src = rec.shot;
      img.alt = "";
      row.append(img);
    } else {
      row.append(el("div", "thumb-empty", "EMPTY"));
    }
    const info = el("div", "slot-info");
    info.append(
      el("div", "slot-name", i === QUICK_SLOT ? "QUICK" : `SLOT ${i}`),
      el("div", "slot-time", rec ? new Date(rec.ts).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "no state"),
    );
    const actions = el("div", "slot-actions");
    const save = el("button", "mini", "SAVE");
    save.onclick = () => void saveState(i);
    actions.append(save);
    if (rec) {
      const load = el("button", "mini load", "LOAD");
      load.onclick = () => void loadState(i);
      const del = el("button", "mini", "DEL");
      del.onclick = () => void library.deleteSlot(id, i).then(renderSlots);
      actions.append(load, del);
    }
    row.append(info, actions);
    rows.push(row);
  }
  if (rom?.id === id) stateSlots.replaceChildren(...rows);
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

async function renderLibrary(): Promise<void> {
  const entries = await library.listLibrary();
  if (entries.length === 0) {
    libraryEl.replaceChildren(note("ROMs you load are kept in this browser."));
    return;
  }
  libraryEl.replaceChildren(...entries.map((entry) => {
    const active = entry.id === rom?.id;
    const row = el("div", active ? "rom-row active" : "rom-row");
    row.append(el("span", "rom-name", entry.name), el("span", "rom-kind", active ? "PLAYING" : fmtSize(entry.size)));
    if (!active) {
      row.onclick = async () => {
        const data = await library.getRom(entry.id);
        if (data) await insertRom(data, entry.name);
      };
      const del = el("button", "rom-del", "✕");
      del.title = "Remove ROM, its save and states";
      del.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Remove ${entry.name} along with its save data and states?`)) {
          void library.removeRom(entry.id, STATE_SLOTS).then(renderLibrary);
        }
      };
      row.append(del);
    }
    return row;
  }));
}

// ---------------------------------------------------------------------------
// BIOS
// ---------------------------------------------------------------------------

async function installBios(data: Uint8Array | null): Promise<void> {
  bios = data;
  await library.storeBios(data);
  updateBiosUi();
  toast(data ? "BIOS installed · used from the next reset" : "BIOS removed · using the built-in one");
}

function updateBiosUi(): void {
  biosChip.textContent = bios ? "REAL BIOS" : "HLE BIOS";
  biosChip.classList.toggle("on", bios !== null);
  biosBtn.textContent = bios ? "REMOVE BIOS" : "LOAD BIOS";
}

biosBtn.addEventListener("click", () => {
  if (bios) void installBios(null);
  else biosInput.click();
});
biosInput.addEventListener("change", () => {
  const f = biosInput.files?.[0];
  biosInput.value = "";
  if (!f) return;
  void f.arrayBuffer().then((b) => {
    if (b.byteLength !== BIOS_SIZE) toast("A GBA BIOS is exactly 16 KB.");
    else void installBios(new Uint8Array(b));
  });
});

// ---------------------------------------------------------------------------
// Cheats
// ---------------------------------------------------------------------------

function applyCheats(announce: boolean): void {
  if (!rom) return;
  const { patches, badLines } = parseCheats(cheatText.value);
  gba.patches = patches;
  localStorage.setItem(`agb-emu:cheats:${rom.id}`, cheatText.value);
  cheatStatus.textContent = badLines.length
    ? `Can't read line ${badLines.join(", ")}`
    : patches.length ? `${patches.length} active` : "";
  if (announce) toast(patches.length ? `${patches.length} cheat${patches.length > 1 ? "s" : ""} active` : "Cheats cleared");
}
cheatApply.addEventListener("click", () => applyCheats(true));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function applySettings(): void {
  crtOverlay.classList.toggle("off", !settings.crt);
  screen.classList.toggle("smooth", settings.smoothing);
  gba.ppu.setColorCorrection(settings.colorCorrection);
  audio.setVolume(settings.muted ? 0 : settings.volume);
  if (!settings.rewind) rewind.clear();
  saveSettings(settings);
  updateDeck();
}

function bindToggle(id: string, key: "crt" | "colorCorrection" | "ghosting" | "smoothing" | "rewind"): void {
  const box = $<HTMLInputElement>(id);
  box.checked = settings[key];
  box.addEventListener("change", () => { settings[key] = box.checked; applySettings(); });
}
bindToggle("optCrt", "crt");
bindToggle("optColor", "colorCorrection");
bindToggle("optGhosting", "ghosting");
bindToggle("optSmoothing", "smoothing");
bindToggle("optRewind", "rewind");

const volumeSlider = $<HTMLInputElement>("optVolume");
volumeSlider.value = String(Math.round(settings.volume * 100));
volumeSlider.addEventListener("input", () => {
  settings.volume = Number(volumeSlider.value) / 100;
  settings.muted = false;
  applySettings();
});

function renderKeymap(): void {
  keymapEl.replaceChildren(...BUTTONS.map((button) => {
    const li = document.createElement("li");
    const key = el("button", "kbd-btn", rebinding === button ? "press a key" : keyLabel(settings.keys[button]));
    key.classList.toggle("listening", rebinding === button);
    key.onclick = () => { rebinding = rebinding === button ? null : button; renderKeymap(); };
    li.append(key, el("span", "", button.length === 1 ? `${button} button` : button));
    return li;
  }));
}

function finishRebind(code: string): void {
  if (!rebinding) return;
  if (code !== "Escape") {
    // A key drives one button: whoever had it swaps with the old binding.
    const previous = settings.keys[rebinding];
    for (const b of BUTTONS) if (settings.keys[b] === code) settings.keys[b] = previous;
    settings.keys[rebinding] = code;
    input.setBindings(settings.keys);
    saveSettings(settings);
  }
  rebinding = null;
  renderKeymap();
}

$("keysReset").addEventListener("click", () => {
  settings.keys = { ...DEFAULT_KEYS };
  input.setBindings(settings.keys);
  saveSettings(settings);
  renderKeymap();
});

async function setSound(on: boolean): Promise<void> {
  await audio.setEnabled(on);
  audioBtn.textContent = on ? "SOUND ON" : "SOUND OFF";
  audioBtn.classList.toggle("on", on);
}
audioBtn.addEventListener("click", () => void setSound(!audio.enabled));
audio.onRate = (hz) => gba.apu.setSampleRate(hz);

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function setRewinding(on: boolean): void {
  if (on && (!rom || !settings.rewind)) return;
  rewindHeld = on;
  updateDeck();
}

addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLTextAreaElement) return;
  if (rebinding) { e.preventDefault(); finishRebind(normalizeCode(e.code)); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (input.keyDown(e.code)) { e.preventDefault(); return; }
  if (e.repeat) { if (e.code === "Space" || e.code === "Backspace") e.preventDefault(); return; }
  switch (e.code) {
    case "F1": void saveState(QUICK_SLOT); break;
    case "F2": void loadState(QUICK_SLOT); break;
    case "F8": screenshot(); break;
    case "Space": fastHeld = true; break;
    case "Backspace": setRewinding(true); break;
    case "KeyP": setPaused(!paused); break;
    case "KeyM": settings.muted = !settings.muted; applySettings(); toast(settings.muted ? "Muted" : "Sound on"); break;
    default: return;
  }
  e.preventDefault();
});
addEventListener("keyup", (e) => {
  input.keyUp(e.code);
  if (e.code === "Space") fastHeld = false;
  if (e.code === "Backspace") setRewinding(false);
});
addEventListener("blur", () => { fastHeld = false; setRewinding(false); });

input.bindTouch(document.querySelectorAll<HTMLElement>("[data-bit]"));

rewindBtn.addEventListener("pointerdown", () => setRewinding(true));
for (const evt of ["pointerup", "pointerleave", "pointercancel"]) {
  rewindBtn.addEventListener(evt, () => setRewinding(false));
}

// File inputs + drag & drop
dropzone.addEventListener("click", () => romInput.click());
romInput.addEventListener("change", () => {
  const f = romInput.files?.[0];
  romInput.value = "";
  if (f) void openFile(f);
});
for (const evt of ["dragover", "dragenter"]) {
  addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
}
addEventListener("dragleave", (e) => { if (!e.relatedTarget) dropzone.classList.remove("drag"); });
addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  const f = e.dataTransfer?.files?.[0];
  if (f) void openFile(f);
});

// Deck buttons
pauseBtn.addEventListener("click", () => setPaused(!paused));
resetBtn.addEventListener("click", () => void powerOn().then(() => toast("Reset")));
speedBtn.addEventListener("click", () => {
  speedIndex = (speedIndex + 1) % SPEEDS.length;
  updateDeck();
});
shotBtn.addEventListener("click", screenshot);
fsBtn.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void consoleEl.requestFullscreen();
});
ejectBtn.addEventListener("click", eject);

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/** Advance the machine for this animation frame. Returns true when there
 *  is a new picture to show. */
function emulate(dt: number): boolean {
  if (rewindHeld) {
    // One snapshot every other display frame: about 3x backwards.
    if (++rewindTick % 2 === 0) return false;
    if (!rewind.stepBack()) setRewinding(false);
    return true;
  }
  if (paused) return false;

  const speed = currentSpeed();
  acc = Math.min(acc + dt * speed, FRAME_MS * speed * 3); // don't spiral after a stall
  const deadline = performance.now() + FRAME_BUDGET_MS;
  let frames = 0;
  while (acc >= FRAME_MS && (frames === 0 || performance.now() < deadline)) {
    gba.runFrame();
    if (settings.rewind) rewind.record();
    acc -= FRAME_MS;
    frames++;
  }
  fpsFrames += frames;
  if (frames === 0) return false;

  if (speed === 1 && audio.enabled) {
    const samples = new Int16Array(4096);
    audio.push(samples.subarray(0, gba.apu.drain(samples)));
  } else {
    gba.apu.clearOutput();
  }
  return true;
}

function tick(t: number): void {
  requestAnimationFrame(tick);
  const dt = lastT ? Math.min(t - lastT, 100) : FRAME_MS;
  lastT = t;

  if (!rom) {
    blinkT += dt;
    if (blinkT > 530) { blinkT = 0; blinkOn = !blinkOn; drawIdleScreen(); }
    return;
  }

  gba.setKeys(input.poll());
  const padId = input.pad?.id ?? "";
  if (padId !== lastPadId) {
    lastPadId = padId;
    padChip.textContent = padId ? padId.slice(0, 26).toUpperCase() : "NO CONTROLLER";
    padChip.classList.toggle("on", padId !== "");
  }

  if (emulate(dt)) present();

  fpsT += dt;
  if (fpsT >= 500) {
    const fps = (fpsFrames * 1000) / fpsT;
    fpsChip.textContent = `${Math.round(fps)} fps · ${Math.round((fps / (1000 / FRAME_MS)) * 100)}%`;
    fpsFrames = 0;
    fpsT = 0;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  bios = await library.loadBios();
  updateBiosUi();
  applySettings();
  renderKeymap();
  drawIdleScreen();
  void renderLibrary();
  requestAnimationFrame(tick);
}

void boot();
