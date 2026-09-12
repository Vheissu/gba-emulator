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
const ejectedHash = await screenHash();
await page.screenshot({ path: "shot-ejected.png", fullPage: true });

const fps = await page.locator("#fps").textContent();
const cartTitle = await page.locator("#cartTitle").textContent();
const libCount = await page.locator(".rom-row").count();

console.log(JSON.stringify({
  fps, cartTitle, ledPaused, slotHasThumb, libCount,
  idleHash, menuHash, testHash, ejectedHash,
  menuChanged: menuHash !== idleHash,
  startWorked: testHash !== menuHash,
  backToIdle: ejectedHash === idleHash,
  errors,
}, null, 2));

await browser.close();
process.exit(errors.length ? 1 : 0);
