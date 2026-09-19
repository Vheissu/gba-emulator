import "./style.css";
import "@fontsource/chakra-petch/400.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/chakra-petch/700.css";
import "@fontsource/chakra-petch/700-italic.css";

import { GBA } from "./emu/gba";
import { AudioOut } from "./ui/audio";
import { pollGamepads } from "./ui/gamepad";
import { drawPixelTextCentered } from "./ui/pixelfont";
import { idbGet, idbPut, idbDel, idbKeys, romKey } from "./ui/idb";

const CPU_HZ = 16777216;
const FRAME_MS = (280896 / CPU_HZ) * 1000; // ~16.74
const STATE_SLOTS = 3;
const QUICK_SLOT = 0;

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
const pauseBtn = $<HTMLButtonElement>("pauseBtn");
const resetBtn = $<HTMLButtonElement>("resetBtn");
const speedBtn = $<HTMLButtonElement>("speedBtn");
const crtBtn = $<HTMLButtonElement>("crtBtn");
const fsBtn = $<HTMLButtonElement>("fsBtn");
const ejectBtn = $<HTMLButtonElement>("ejectBtn");
const crtOverlay = $("crt");
const consoleEl = $("consoleEl");
const stateSlots = $("stateSlots");
const libraryEl = $("library");
const toastEl = $("toast");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const gba = new GBA();
const audio = new AudioOut();
const audioScratch = new Int16Array(4096);

let romData: Uint8Array | null = null;
let romId = "";
let romName = "";
let bios: Uint8Array | null = null;

let running = false;
let paused = false;
let speed = 1;
let spaceHeld = false;
let keyboardMask = 0;
let touchMask = 0;
// Bits cleared on keyup but held for one delivered frame so very short
// presses are never dropped between two emulated frames.
let pendingRelease = 0;
let lastPadId = "";
let acc = 0;
let lastT = 0;
let fpsCount = 0;
let fpsT = 0;
let saveChecksum = -1;
let blinkT = 0;
let blinkOn = true;

const keyMap: Record<string, number> = {
  x: 1, z: 2,
  shift: 4, enter: 8,
  arrowright: 16, arrowleft: 32, arrowup: 64, arrowdown: 128,
  s: 256, a: 512,
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const imageData = new ImageData(
  new Uint8ClampedArray(gba.ppu.framebuffer.buffer, gba.ppu.framebuffer.byteOffset, 240 * 160 * 4),
  240, 160,
);

function present(): void {
  ctx.putImageData(imageData, 0, 0);
}

function drawIdleScreen(): void {
  ctx.fillStyle = "#0b0913";
  ctx.fillRect(0, 0, 240, 160);
  drawPixelTextCentered(ctx, 120, 52, "AGB-EMU", 3, "#56509f");
  drawPixelTextCentered(ctx, 120, 84, "GAME BOY ADVANCE", 1, "#8f88b5");
  if (blinkOn) {
    drawPixelTextCentered(ctx, 120, 112, "INSERT CARTRIDGE", 2, "#d8d2f0");
  }
  drawPixelTextCentered(ctx, 120, 138, "DROP .GBA OR CLICK SLOT", 1, "#5d5680");
}

// ---------------------------------------------------------------------------
// Toasts + status
// ---------------------------------------------------------------------------

let toastTimer = 0;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

function setLed(mode: "off" | "on" | "paused"): void {
  powerLed.classList.toggle("on", mode === "on");
  powerLed.classList.toggle("paused", mode === "paused");
}

function updateDeck(): void {
  const hasRom = romData !== null;
  pauseBtn.disabled = !hasRom;
  resetBtn.disabled = !hasRom;
  speedBtn.disabled = !hasRom;
  ejectBtn.disabled = !hasRom;
  pauseBtn.textContent = paused ? "RESUME" : "PAUSE";
  speedBtn.textContent = `${speed}× SPEED`;
  speedBtn.classList.toggle("on", speed !== 1);
}

// ---------------------------------------------------------------------------
// ROM loading
// ---------------------------------------------------------------------------

function fmtSize(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

async function loadRom(data: Uint8Array, name: string): Promise<void> {
  if (data.length < 0xc0 || data.length > 32 * 1024 * 1024) {
    toast("That file doesn't look like a GBA ROM.");
    return;
  }
  persistSaveRam(); // flush the previous game's save first
  romData = data;
  romName = name.replace(/\.[^.]+$/, "");
  romId = romKey(data);
  gba.setBios(bios);
  const info = gba.loadRom(data);

  // Restore cartridge save memory if we have one stored.
  const stored = await idbGet<{ data: number[] }>("saves", romId);
  if (stored && gba.save.size > 0) {
    gba.save.deserialize(Uint8Array.from(stored.data));
  }
  saveChecksum = -1;

  // Library
  await idbPut("roms", romId, { name: romName, data, ts: Date.now() });

  // Cart UI
  cartTitle.textContent = (info.title || romName).toUpperCase();
  cartMeta.textContent = `${info.code} · ${fmtSize(data.length)} · ${info.saveKind.toUpperCase()}`;
  cart.hidden = false;
  requestAnimationFrame(() => cart.classList.add("inserted"));
  slotHint.textContent = "CARTRIDGE INSERTED";

  screenMsg.textContent = "";
  paused = false;
  running = true;
  setLed("on");
  updateDeck();
  renderLibrary();
  renderSlots();
  toast(`${cartTitle.textContent} loaded`);
}

function eject(): void {
  persistSaveRam();
  running = false;
  paused = false;
  romData = null;
  romId = "";
  gba.setKeys(0);
  cart.classList.remove("inserted");
  setTimeout(() => { cart.hidden = true; }, 450);
  slotHint.textContent = "DROP A .GBA FILE · CLICK TO BROWSE";
  screenMsg.textContent = "";
  setLed("off");
  updateDeck();
  renderLibrary();
  renderSlots();
  drawIdleScreen();
}

// ---------------------------------------------------------------------------
// Save RAM persistence
// ---------------------------------------------------------------------------

function quickChecksum(d: Uint8Array): number {
  let h = d.length;
  for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0;
  return h;
}

function persistSaveRam(): void {
  if (!romId || gba.save.size === 0) return;
  const data = gba.save.serialize();
  const sum = quickChecksum(data);
  if (sum === saveChecksum) return;
  saveChecksum = sum;
  void idbPut("saves", romId, { data: Array.from(data) });
}
setInterval(persistSaveRam, 3000);
addEventListener("pagehide", persistSaveRam);

// ---------------------------------------------------------------------------
// Save states
// ---------------------------------------------------------------------------

interface SlotRec { state: Uint8Array; shot: string; ts: number; }

const thumbCanvas = document.createElement("canvas");
thumbCanvas.width = 120; thumbCanvas.height = 80;
const thumbCtx = thumbCanvas.getContext("2d")!;

function slotKey(i: number): string { return `${romId}:s${i}`; }

async function saveState(i: number): Promise<void> {
  if (!romData) return;
  present();
  thumbCtx.drawImage(screen, 0, 0, 120, 80);
  const rec: SlotRec = {
    state: gba.serializeState(),
    shot: thumbCanvas.toDataURL("image/png"),
    ts: Date.now(),
  };
  await idbPut("states", slotKey(i), rec);
  renderSlots();
  toast(`State saved · slot ${i + 1}`);
}

async function loadState(i: number): Promise<void> {
  const rec = await idbGet<SlotRec>("states", slotKey(i));
  if (!rec || !romData) return;
  if (gba.deserializeState(rec.state)) {
    present();
    toast(`State loaded · slot ${i + 1}`);
  } else {
    toast("That save state doesn't match this ROM.");
  }
}

async function renderSlots(): Promise<void> {
  if (!romData) {
    stateSlots.innerHTML = `<p class="panel-note">Insert a cartridge to use save states.</p>`;
    return;
  }
  stateSlots.innerHTML = "";
  for (let i = 0; i < STATE_SLOTS; i++) {
    const rec = await idbGet<SlotRec>("states", slotKey(i));
    const row = document.createElement("div");
    row.className = "slot-row";
    const label = i === QUICK_SLOT ? "QUICK" : `SLOT ${i + 1}`;
    row.innerHTML = rec
      ? `<img src="${rec.shot}" alt="" /><div class="slot-info">
           <div class="slot-name">${label}</div>
           <div class="slot-time">${new Date(rec.ts).toLocaleString()}</div>
         </div>`
      : `<div class="thumb-empty">EMPTY</div><div class="slot-info">
           <div class="slot-name">${label}</div>
           <div class="slot-time">no state</div>
         </div>`;
    const actions = document.createElement("div");
    actions.className = "slot-actions";
    const sv = document.createElement("button");
    sv.className = "mini"; sv.textContent = "SAVE";
    sv.onclick = () => void saveState(i);
    actions.appendChild(sv);
    if (rec) {
      const ld = document.createElement("button");
      ld.className = "mini load"; ld.textContent = "LOAD";
      ld.onclick = () => void loadState(i);
      actions.appendChild(ld);
      const del = document.createElement("button");
      del.className = "mini"; del.textContent = "DEL";
      del.onclick = async () => { await idbDel("states", slotKey(i)); renderSlots(); };
      actions.appendChild(del);
    }
    row.appendChild(actions);
    stateSlots.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

interface RomRec { name: string; data: Uint8Array; ts: number; }

async function renderLibrary(): Promise<void> {
  const keys = (await idbKeys("roms")).filter((k) => k !== romId);
  const recs: [string, RomRec][] = [];
  for (const k of keys) {
    const r = await idbGet<RomRec>("roms", k);
    if (r) recs.push([k, r]);
  }
  recs.sort((a, b) => b[1].ts - a[1].ts);
  libraryEl.innerHTML = "";
  if (recs.length === 0 && !romData) {
    libraryEl.innerHTML = `<p class="panel-note">ROMs you load are kept in this browser.</p>`;
    return;
  }
  for (const [k, r] of recs.slice(0, 12)) {
    const row = document.createElement("div");
    row.className = "rom-row";
    row.innerHTML = `<span class="rom-name">${r.name}</span>
      <span class="rom-kind">${fmtSize(r.data.length)}</span>`;
    row.onclick = () => void loadRom(r.data, r.name);
    const del = document.createElement("button");
    del.className = "rom-del"; del.textContent = "✕"; del.title = "Remove";
    del.onclick = async (e) => {
      e.stopPropagation();
      await idbDel("roms", k);
      renderLibrary();
    };
    row.appendChild(del);
    libraryEl.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === "f1") { e.preventDefault(); void saveState(QUICK_SLOT); return; }
  if (k === "f2") { e.preventDefault(); void loadState(QUICK_SLOT); return; }
  if (k === " ") { e.preventDefault(); spaceHeld = true; return; }
  const bit = keyMap[k];
  if (bit !== undefined) {
    e.preventDefault();
    keyboardMask |= bit;
    pendingRelease &= ~bit;
  }
});
addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  if (k === " ") { spaceHeld = false; return; }
  const bit = keyMap[k];
  if (bit !== undefined) pendingRelease |= bit;
});
addEventListener("blur", () => { keyboardMask = 0; spaceHeld = false; });

// Touch / click controls on the shell buttons.
for (const el of document.querySelectorAll<HTMLElement>("[data-bit]")) {
  const bit = Number(el.dataset.bit);
  const press = (on: boolean) => {
    if (on) touchMask |= bit; else touchMask &= ~bit;
    el.classList.toggle("pressed", on);
  };
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    press(true);
  });
  el.addEventListener("pointerup", () => press(false));
  el.addEventListener("pointercancel", () => press(false));
  el.addEventListener("lostpointercapture", () => press(false));
}

// File inputs + drag & drop
dropzone.addEventListener("click", () => romInput.click());
romInput.addEventListener("change", () => {
  const f = romInput.files?.[0];
  if (f) void f.arrayBuffer().then((b) => loadRom(new Uint8Array(b), f.name));
  romInput.value = "";
});

for (const evt of ["dragover", "dragenter"]) {
  addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
}
for (const evt of ["dragleave", "drop"]) {
  addEventListener(evt, (e) => {
    e.preventDefault();
    if (evt === "dragleave" && (e as DragEvent).relatedTarget) return;
    dropzone.classList.remove("drag");
  });
}
addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) void f.arrayBuffer().then((b) => loadRom(new Uint8Array(b), f.name));
});

biosBtn.addEventListener("click", () => biosInput.click());
biosInput.addEventListener("change", () => {
  const f = biosInput.files?.[0];
  biosInput.value = "";
  if (!f) return;
  void f.arrayBuffer().then(async (b) => {
    const d = new Uint8Array(b);
    if (d.length !== 16384) { toast("A GBA BIOS is exactly 16 KB."); return; }
    bios = d;
    await idbPut("meta", "bios", { data: Array.from(d) });
    biosChip.textContent = "BIOS OK";
    toast("BIOS loaded · used on next cartridge insert");
  });
});

// Deck buttons
pauseBtn.addEventListener("click", () => {
  if (!romData) return;
  paused = !paused;
  screenMsg.textContent = paused ? "PAUSED" : "";
  setLed(paused ? "paused" : "on");
  updateDeck();
});
resetBtn.addEventListener("click", async () => {
  if (!romData) return;
  gba.setBios(bios);
  gba.loadRom(romData);
  const stored = await idbGet<{ data: number[] }>("saves", romId);
  if (stored && gba.save.size > 0) gba.save.deserialize(Uint8Array.from(stored.data));
  paused = false;
  setLed("on");
  updateDeck();
  toast("Reset");
});
speedBtn.addEventListener("click", () => {
  speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
  updateDeck();
});
crtBtn.addEventListener("click", () => {
  const off = crtOverlay.classList.toggle("off");
  crtBtn.textContent = off ? "CRT: OFF" : "CRT: ON";
  crtBtn.classList.toggle("on", !off);
});
fsBtn.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void consoleEl.requestFullscreen();
});
ejectBtn.addEventListener("click", eject);
audioBtn.addEventListener("click", () => {
  void audio.toggle().then((on) => {
    audioBtn.textContent = on ? "SOUND ON" : "SOUND OFF";
    audioBtn.classList.toggle("on", on);
  });
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function tick(t: number): void {
  requestAnimationFrame(tick);
  const dt = lastT ? Math.min(t - lastT, 100) : FRAME_MS;
  lastT = t;

  // Idle blink when nothing is running.
  if (!running) {
    blinkT += dt;
    if (blinkT > 530) { blinkT = 0; blinkOn = !blinkOn; drawIdleScreen(); }
    return;
  }

  // Gamepad
  const { mask: padMask, pad } = pollGamepads();
  const padId = pad ? pad.id : "";
  if (padId !== lastPadId) {
    lastPadId = padId;
    padChip.textContent = pad ? pad.id.slice(0, 26).toUpperCase() : "NO CONTROLLER";
    padChip.classList.toggle("on", !!pad);
  }

  gba.setKeys(keyboardMask | padMask | touchMask);
  if (pendingRelease) { keyboardMask &= ~pendingRelease; pendingRelease = 0; }

  if (!paused) {
    const effSpeed = spaceHeld ? 4 : speed;
    acc += dt * effSpeed;
    let frames = 0;
    while (acc >= FRAME_MS && frames < 6) {
      gba.runFrame();
      acc -= FRAME_MS;
      frames++;
      fpsCount++;
    }
    if (acc > FRAME_MS * 6) acc = 0; // long stall: don't spiral
    if (frames > 0) {
      present();
      const n = gba.apu.drain(audioScratch);
      if (n > 0) audio.push(audioScratch.subarray(0, n));
    }
  }

  // FPS meter
  fpsT += dt;
  if (fpsT >= 500) {
    const fps = Math.round((fpsCount * 1000) / fpsT);
    fpsChip.textContent = `${fps} fps`;
    fpsCount = 0;
    fpsT = 0;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  const storedBios = await idbGet<{ data: number[] }>("meta", "bios");
  if (storedBios) {
    bios = Uint8Array.from(storedBios.data);
    biosChip.textContent = "BIOS OK";
  }
  drawIdleScreen();
  updateDeck();
  crtBtn.classList.add("on");
  renderLibrary();
  requestAnimationFrame(tick);
}

void boot();
