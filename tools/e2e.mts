// Drives the UI in the system Chrome: screenshots idle, loads a ROM via
// the file input, drives keypad + shell buttons, exercises save states.
import { chromium } from "playwright-core";

const URL = process.env.URL || "http://localhost:5173";
const ROM = process.env.ROM || "testroms/armwrestler-fixed.gba";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

const screenHash = () => page.evaluate(() => {
  const c = document.getElementById("screen") as HTMLCanvasElement;
  const d = c.getContext("2d")!.getImageData(0, 0, 240, 160).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 251) h = (h * 31 + d[i]) | 0;
  return h;
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.screenshot({ path: "shot-idle.png", fullPage: true });
const idleHash = await screenHash();

// Load ROM through the hidden file input.
await page.locator("#romInput").setInputFiles(ROM);
await page.waitForTimeout(2500);
const menuHash = await screenHash();
await page.screenshot({ path: "shot-running.png", fullPage: true });

// Press START (down/up with a realistic hold) -> should enter ARM ALU test.
await page.keyboard.down("Enter");
await page.waitForTimeout(80);
await page.keyboard.up("Enter");
await page.waitForTimeout(1200);
const testHash = await screenHash();
await page.screenshot({ path: "shot-test.png", fullPage: true });

// Shell button: pointer the on-screen B button.
await page.locator(".abtn.b").dispatchEvent("pointerdown");
await page.waitForTimeout(120);
await page.locator(".abtn.b").dispatchEvent("pointerup");

// Quick save via F1 -> thumbnail row appears; F2 loads it back.
await page.keyboard.press("F1");
await page.waitForTimeout(600);
const slotHasThumb = await page.locator(".slot-row img").count();
await page.keyboard.press("F2");
await page.waitForTimeout(400);

// Pause -> LED amber; resume.
await page.locator("#pauseBtn").click();
await page.waitForTimeout(200);
const ledPaused = await page.locator("#powerLed").getAttribute("class");
await page.locator("#pauseBtn").click();

// Eject -> back to idle.
await page.locator("#ejectBtn").click();
await page.waitForTimeout(800);
// The idle screen blinks, so give it a full cycle to match the first capture.
let ejectedHash = await screenHash();
for (let i = 0; i < 30 && ejectedHash !== idleHash; i++) {
  await page.waitForTimeout(50);
  ejectedHash = await screenHash();
}
await page.screenshot({ path: "shot-ejected.png", fullPage: true });

// Rewind: play on, hold Backspace, and the picture should change while
// the REWIND banner shows.
await page.locator("#romInput").setInputFiles(ROM);
await page.waitForTimeout(2500);
await page.keyboard.down("Backspace");
await page.waitForTimeout(200);
const rewindBanner = await page.locator("#screenMsg").textContent();
await page.keyboard.up("Backspace");

// Rebind A to K, then restore defaults.
await page.locator("#keymap .kbd-btn").first().click();
await page.keyboard.press("KeyK");
const rebound = await page.locator("#keymap .kbd-btn").first().textContent();
await page.locator("#keysReset").click();

// Settings persist across reloads.
await page.locator("#optCrt").uncheck();
const crtHidden = await page.locator("#crt.off").count();

// Cheats parse and report.
await page.locator("#cheatText").fill("02000000:63\nnot a code");
await page.locator("#cheatApply").click();
const cheatStatus = await page.locator("#cheatStatus").textContent();
await page.locator("#cheatText").fill("");
await page.locator("#cheatApply").click();
await page.locator("#optCrt").check();

await page.waitForTimeout(1200);
const fps = await page.locator("#fps").textContent();
const cartTitle = await page.locator("#cartTitle").textContent();
const libCount = await page.locator(".rom-row").count();

console.log(JSON.stringify({
  fps, cartTitle, ledPaused, slotHasThumb, libCount,
  rewindBanner, rebound, crtHidden, cheatStatus,
  idleHash, menuHash, testHash, ejectedHash,
  menuChanged: menuHash !== idleHash,
  startWorked: testHash !== menuHash,
  backToIdle: ejectedHash === idleHash,
  errors,
}, null, 2));

await browser.close();
process.exit(errors.length ? 1 : 0);
